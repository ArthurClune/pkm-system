#!/usr/bin/python3
"""Mirror the PKM backups into an iCloud Drive folder, once a day.

Runs from launchd (see com.PLACEHOLDER.pkm.icloud-backup.plist.template) on
the system /usr/bin/python3 — stdlib only, Python 3.9 compatible.

Layout written under --dest:

    db/pkm-YYYY-MM-DD.sqlite3      the nightly sqlite snapshots, newest
                                   --keep-days of them
    data/main/                     plain copy of the data dir as of
                                   data/main.manifest.json["date"]
    data/incr/YYYY-MM-DD/files/    files added or changed since the previous
                                   snapshot (main or the previous incr)
    data/incr/YYYY-MM-DD/deleted.txt   paths removed since the previous
                                   snapshot, one per line
    data/incr/YYYY-MM-DD/manifest.json full listing of the tree on that day

Incrementals chain forward from main: the tree on day T is main with every
incr up to and including T applied in date order. Once main is older than
--keep-days, the oldest incr is folded into main (its files moved in, its
deletions applied, main's manifest replaced) and removed, so the oldest
restorable point stays ~--keep-days ago and the total size stays bounded at
one tree plus --keep-days of churn.

The live sqlite database (and its -wal/-shm) is excluded from the data
mirror: copying a WAL-mode database file out from under the server is not a
consistent snapshot, and the nightly snapshots under db/ already cover it.
Restore day T = `restore --date T` for assets/config plus db/pkm-T.sqlite3.

config.json is mirrored without its `session_secret` (it would let anyone who
reads the iCloud folder mint a login cookie); every other key is kept, for
restore. The redacted bytes are built in memory and written straight to their
place under --dest, so the secret never lands in iCloud, not even in a temp
file. As a guarantee that does not depend on file names, any other file whose
bytes contain the secret (a copy, a hard link, any case of the hex) is not
mirrored and the run exits 1. If config.json cannot be read or does not parse
as a JSON object, it is not mirrored either (the previous mirrored copy stays
in the snapshot), the run exits 1, and the rest of the backup is still taken.
`restore` gives the restored config a fresh secret, so every device has to log
in again.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

DATE_FMT = "%Y-%m-%d"
# Cheap first line against copies of config.json; the content guard in
# copy_source is what actually keeps the secret out.
DEFAULT_EXCLUDES = ["pkm.sqlite3", "pkm.sqlite3-wal", "pkm.sqlite3-shm", ".DS_Store",
                    "config.json?*", ".config.json*"]
Manifest = Dict[str, Tuple[int, int]]  # relpath -> (size, mtime_ns)
CONFIG_NAME = "config.json"
SECRET_KEY = "session_secret"
CHUNK = 1 << 20


# ---------------------------------------------------------------- helpers ---

def parse_date(s: str) -> dt.date:
    return dt.datetime.strptime(s, DATE_FMT).date()


def date_from_name(name: str, prefix: str = "", suffix: str = "") -> Optional[dt.date]:
    """Extract the YYYY-MM-DD embedded in ``prefix + date + suffix``."""
    if not (name.startswith(prefix) and name.endswith(suffix)):
        return None
    core = name[len(prefix):len(name) - len(suffix)] if suffix else name[len(prefix):]
    try:
        return parse_date(core)
    except ValueError:
        return None


def scan_tree(root: Path, excludes: List[str]) -> Manifest:
    out: Manifest = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for fn in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            if any(fnmatch.fnmatch(fn, pat) or fnmatch.fnmatch(rel, pat) for pat in excludes):
                continue
            st = os.lstat(os.path.join(dirpath, fn))
            if not stat.S_ISREG(st.st_mode):
                continue  # symlinks, sockets, etc. are not backed up
            out[rel] = (st.st_size, st.st_mtime_ns)
    return out


class Guard:
    """What keeps the session secret out of the mirror for one run."""

    def __init__(self) -> None:
        self.overrides: Dict[str, bytes] = {}
        self.secret: Optional[bytes] = None  # lower-case hex bytes
        self.config_error: Optional[str] = None
        self.leaks: List[str] = []

    @property
    def problems(self) -> bool:
        return bool(self.config_error or self.leaks)


def redact_config(raw: bytes) -> Tuple[bytes, Optional[str]]:
    """(``raw`` config.json without its session secret, the secret).

    ValueError if it is not a JSON object.
    """
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise ValueError("config.json is not valid JSON: %s" % e)
    if not isinstance(obj, dict):
        raise ValueError("config.json is not a JSON object")
    secret = obj.pop(SECRET_KEY, None)
    return (json.dumps(obj, indent=2).encode("utf-8"),
            secret if isinstance(secret, str) else None)


def find_config(current: Manifest) -> Optional[str]:
    """The top-level config.json's relpath, matched case-insensitively (the
    live filesystem may be case-insensitive)."""
    for rel in current:
        if rel.lower() == CONFIG_NAME:
            return rel
    return None


def redact_live_config(live: Path, current: Manifest, prev: Manifest) -> Guard:
    """Swap config.json's manifest entry for the redacted copy's.

    The size becomes the redacted size (restore checks sizes against the
    manifest); the mtime stays the live file's, so editing the live file
    still registers as a change. On a read or parse failure nothing is
    copied: the previous manifest's entry is carried forward (or dropped if
    there is none) and ``config_error`` says why.
    """
    guard = Guard()
    rel = find_config(current)
    if rel is None:
        return guard
    raw = b""
    try:
        raw = (live / rel).read_bytes()
        redacted, secret = redact_config(raw)
    except (OSError, ValueError) as e:
        guard.config_error = str(e)
        if rel in prev:
            current[rel] = prev[rel]
        else:
            del current[rel]
        match = re.search(rb'"%s"\s*:\s*"([0-9A-Za-z]+)"' % SECRET_KEY.encode(), raw)
        if match:
            guard.secret = match.group(1).lower()
        return guard
    current[rel] = (len(redacted), current[rel][1])
    guard.overrides[rel] = redacted
    if secret and len(secret) >= 8:
        guard.secret = secret.encode("utf-8").lower()
    return guard


def contains_secret(path: Path, secret: bytes) -> bool:
    """Stream ``path`` for ``secret`` (lower-case), ignoring ASCII case, with
    an overlap so a match across a chunk boundary is found."""
    keep = len(secret) - 1
    tail = b""
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                return False
            window = (tail + chunk).lower()
            if secret in window:
                return True
            tail = window[len(window) - keep:] if keep else b""


def write_json_atomic(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def read_manifest(path: Path) -> Tuple[dt.date, Manifest]:
    with open(path) as f:
        obj = json.load(f)
    files = {k: (int(v[0]), int(v[1])) for k, v in obj["files"].items()}
    return parse_date(obj["date"]), files


def manifest_obj(date: dt.date, files: Manifest) -> dict:
    return {"date": date.strftime(DATE_FMT), "files": {k: list(v) for k, v in files.items()}}


def copy_file(src: Path, dst: Path) -> None:
    """copy2 via a temp name so a half-written file never has the final name."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def copy_source(live: Path, rel: str, dst: Path, guard: Guard) -> bool:
    """Copy live/rel to dst, or write its override bytes with live's mtime
    and mode. False, copying nothing, if the file holds the session secret.

    The search is a separate read pass so a file holding the secret is never
    written under the destination, even briefly.
    """
    if rel not in guard.overrides:
        if guard.secret and contains_secret(live / rel, guard.secret):
            guard.leaks.append(rel)
            return False
        copy_file(live / rel, dst)
        return True
    st = os.stat(live / rel)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".part")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(guard.overrides[rel])
    os.chmod(tmp, st.st_mode & 0o7777)
    os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
    os.replace(tmp, dst)
    return True


def ensure_materialised(path: Path, timeout: float = 120.0) -> None:
    """iCloud Drive may have evicted ``path`` to a ``.name.icloud`` stub.

    Ask bird to download it and wait; raise if it never shows up so the
    caller aborts (and retries tomorrow) instead of silently losing a file.
    """
    if path.exists():
        return
    stub = path.with_name("." + path.name + ".icloud")
    if not stub.exists():
        raise FileNotFoundError(str(path))
    subprocess.run(["brctl", "download", str(path)], check=False)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(1)
    raise TimeoutError("iCloud never materialised %s" % path)


def remove_empty_parents(path: Path, stop: Path) -> None:
    p = path.parent
    while p != stop and p.is_dir():
        try:
            p.rmdir()
        except OSError:
            return
        p = p.parent


def apply_incr(incr_dir: Path, target: Path) -> Tuple[int, int]:
    """Apply one incremental onto ``target`` (copying, not moving)."""
    files_dir = incr_dir / "files"
    copied = deleted = 0
    if files_dir.is_dir():
        for dirpath, _, filenames in os.walk(files_dir):
            for fn in filenames:
                src = Path(dirpath) / fn
                rel = src.relative_to(files_dir)
                ensure_materialised(src)
                copy_file(src, target / rel)
                copied += 1
    deleted_txt = incr_dir / "deleted.txt"
    if deleted_txt.exists():
        for line in deleted_txt.read_text().splitlines():
            rel = line.strip()
            if not rel:
                continue
            victim = target / rel
            if victim.exists():
                victim.unlink()
                deleted += 1
            remove_empty_parents(victim, target)
    return copied, deleted


# --------------------------------------------------------------- db mirror ---

def mirror_db(src_dir: Path, dest_dir: Path, today: dt.date, keep_days: int) -> Tuple[int, int]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    cutoff = today - dt.timedelta(days=keep_days)
    copied = pruned = 0
    for src in sorted(src_dir.glob("pkm-*.sqlite3")):
        d = date_from_name(src.name, "pkm-", ".sqlite3")
        if d is None or d < cutoff:
            continue
        dst = dest_dir / src.name
        if dst.exists() and dst.stat().st_size == src.stat().st_size:
            continue
        copy_file(src, dst)
        copied += 1
    for old in sorted(dest_dir.glob("pkm-*.sqlite3")):
        d = date_from_name(old.name, "pkm-", ".sqlite3")
        if d is not None and d < cutoff:
            old.unlink()
            pruned += 1
    return copied, pruned


# ------------------------------------------------------------- data mirror ---

class DataMirror:
    def __init__(self, dest: Path):
        self.root = dest
        self.main = dest / "main"
        self.main_manifest = dest / "main.manifest.json"
        self.incr_root = dest / "incr"

    def incr_dates(self) -> List[dt.date]:
        if not self.incr_root.is_dir():
            return []
        out = []
        for p in self.incr_root.iterdir():
            d = date_from_name(p.name)
            if d is not None and p.is_dir():
                out.append(d)
        return sorted(out)

    def incr_dir(self, d: dt.date) -> Path:
        return self.incr_root / d.strftime(DATE_FMT)

    def create_main(self, live: Path, manifest: Manifest, today: dt.date,
                    guard: Guard) -> None:
        tmp = self.root / "main.tmp"
        if tmp.exists():
            shutil.rmtree(tmp)
        for rel in list(manifest):
            if not copy_source(live, rel, tmp / rel, guard):
                del manifest[rel]
        if self.main.exists():
            shutil.rmtree(self.main)
        os.replace(tmp, self.main)
        write_json_atomic(self.main_manifest, manifest_obj(today, manifest))

    def previous_manifest(self, today: dt.date) -> Tuple[dt.date, Manifest]:
        """The latest snapshot strictly before today (so a rerun today
        rebuilds today's incr)."""
        earlier = [d for d in self.incr_dates() if d < today]
        if earlier:
            return read_manifest(self.incr_dir(earlier[-1]) / "manifest.json")
        return read_manifest(self.main_manifest)

    def write_incr(self, live: Path, current: Manifest, today: dt.date,
                   guard: Guard) -> Tuple[int, int]:
        prev_date, prev = self.previous_manifest(today)
        if prev_date >= today:
            raise SystemExit("main snapshot (%s) is not older than today (%s); clock went backwards?"
                             % (prev_date, today))
        later = [d for d in self.incr_dates() if d > today]
        if later:
            raise SystemExit("incrementals newer than today exist (%s); refusing to rewrite history"
                             % ", ".join(d.strftime(DATE_FMT) for d in later))
        changed = [rel for rel, sig in current.items() if prev.get(rel) != sig]

        final = self.incr_dir(today)
        tmp = self.incr_root / (final.name + ".tmp")
        if tmp.exists():
            shutil.rmtree(tmp)
        (tmp / "files").mkdir(parents=True)
        for rel in list(changed):
            if not copy_source(live, rel, tmp / "files" / rel, guard):
                changed.remove(rel)
                del current[rel]
        deleted = sorted(rel for rel in prev if rel not in current)
        (tmp / "deleted.txt").write_text("".join(r + "\n" for r in deleted))
        write_json_atomic(tmp / "manifest.json", manifest_obj(today, current))
        if final.exists():
            shutil.rmtree(final)
        os.replace(tmp, final)
        return len(changed), len(deleted)

    def fold(self, today: dt.date, keep_days: int) -> List[dt.date]:
        """Fold the oldest incrementals into main until main is within
        keep_days."""
        cutoff = today - dt.timedelta(days=keep_days)
        folded: List[dt.date] = []
        while True:
            main_date, _ = read_manifest(self.main_manifest)
            dates = self.incr_dates()
            if main_date >= cutoff or not dates:
                return folded
            oldest = dates[0]
            if oldest > today:
                return folded
            incr = self.incr_dir(oldest)
            # Idempotent if interrupted: re-applying copies the same files and
            # deletes the same paths; the manifest is rewritten last and the
            # incr removed only after that.
            _, files = read_manifest(incr / "manifest.json")
            apply_incr(incr, self.main)
            write_json_atomic(self.main_manifest, manifest_obj(oldest, files))
            shutil.rmtree(incr)
            folded.append(oldest)

    def restore(self, date: dt.date, out: Path) -> Tuple[int, int]:
        main_date, _ = read_manifest(self.main_manifest)
        if date < main_date:
            raise SystemExit("%s predates the oldest retained snapshot (%s)" % (date, main_date))
        out.mkdir(parents=True, exist_ok=True)
        if any(out.iterdir()):
            raise SystemExit("restore target %s is not empty" % out)
        copied = 0
        for dirpath, _, filenames in os.walk(self.main):
            for fn in filenames:
                src = Path(dirpath) / fn
                ensure_materialised(src)
                copy_file(src, out / src.relative_to(self.main))
                copied += 1
        applied = 0
        expected_date, expected = main_date, None
        for d in self.incr_dates():
            if d > date:
                break
            apply_incr(self.incr_dir(d), out)
            applied += 1
            expected_date, expected = read_manifest(self.incr_dir(d) / "manifest.json")
        if expected is None:
            _, expected = read_manifest(self.main_manifest)
        got = scan_tree(out, [])
        mismatch = {rel for rel, sig in expected.items() if got.get(rel, (None,))[0] != sig[0]}
        mismatch |= set(got) - set(expected)
        if mismatch:
            raise SystemExit("restore of %s does not match its manifest (%d paths), e.g. %s"
                             % (expected_date, len(mismatch), sorted(mismatch)[:3]))
        return copied, applied

    def ensure_secret(self, out: Path) -> bool:
        """Give a restored config.json a fresh session secret if it has none.

        Run after the manifest check, which compares against the redacted
        size. True when a secret was written.
        """
        names = [p for p in out.iterdir() if p.name.lower() == CONFIG_NAME]
        if not names:
            return False
        path = names[0]
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, RecursionError):
            return False
        if not isinstance(obj, dict) or SECRET_KEY in obj:
            return False
        obj[SECRET_KEY] = secrets.token_bytes(32).hex()
        tmp = path.with_name(path.name + ".part")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp, path)
        return True


# -------------------------------------------------------------------- main ---

def cmd_backup(args: argparse.Namespace) -> int:
    today = parse_date(args.today) if args.today else dt.date.today()
    dest = Path(args.dest)
    if not dest.parent.is_dir():
        print("icloud backup FAILED: %s does not exist (iCloud Drive not mounted?)" % dest.parent,
              file=sys.stderr)
        return 2
    dest.mkdir(exist_ok=True)

    db_copied, db_pruned = mirror_db(Path(args.sqlite_backups), dest / "db", today, args.keep_days)

    live = Path(args.data_dir)
    mirror = DataMirror(dest / "data")
    excludes = DEFAULT_EXCLUDES + list(args.exclude or [])
    current = scan_tree(live, excludes)
    existing = mirror.main_manifest.exists()
    prev = mirror.previous_manifest(today)[1] if existing else {}
    guard = redact_live_config(live, current, prev)
    if guard.config_error:
        print("icloud backup: config.json NOT mirrored: %s" % guard.config_error, file=sys.stderr)
    if not existing:
        mirror.create_main(live, current, today, guard)
        data_note = "main created (%d files)" % len(current)
        folded: List[dt.date] = []
    else:
        changed, deleted = mirror.write_incr(live, current, today, guard)
        folded = mirror.fold(today, args.keep_days)
        data_note = "incr %s (+%d files, -%d)" % (today, changed, deleted)
    fold_note = (" folded=" + ",".join(d.strftime(DATE_FMT) for d in folded)) if folded else ""
    for rel in guard.leaks:
        print("icloud backup: %s NOT mirrored: it contains the session secret" % rel,
              file=sys.stderr)
    print("icloud backup %s: db copied=%d pruned=%d data: %s%s"
          % ("PARTIAL" if guard.problems else "ok", db_copied, db_pruned, data_note, fold_note))
    return 1 if guard.problems else 0


def cmd_restore(args: argparse.Namespace) -> int:
    mirror = DataMirror(Path(args.dest) / "data")
    date = parse_date(args.date)
    copied, applied = mirror.restore(date, Path(args.out))
    if mirror.ensure_secret(Path(args.out)):
        print("config.json has a new session_secret: every device must log in again")
    db = Path(args.dest) / "db" / ("pkm-%s.sqlite3" % args.date)
    print("restored data dir as of %s to %s (%d files from main, %d incrementals applied)"
          % (args.date, args.out, copied, applied))
    if db.exists():
        print("matching database: %s" % db)
    else:
        print("no db/pkm-%s.sqlite3 snapshot; pick the nearest date under db/" % args.date)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")
    p.set_defaults(func=cmd_backup)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--dest", required=True, help="iCloud folder to mirror into")

    b = sub.add_parser("backup", help="take today's snapshot (default)")
    add_common(b)
    b.add_argument("--data-dir", required=True)
    b.add_argument("--sqlite-backups", required=True, help="dir holding pkm-YYYY-MM-DD.sqlite3")
    b.add_argument("--keep-days", type=int, default=30)
    b.add_argument("--exclude", action="append", help="extra glob to skip in the data dir")
    b.add_argument("--today", help="override the date (YYYY-MM-DD), for testing")
    b.set_defaults(func=cmd_backup)

    r = sub.add_parser("restore", help="rebuild the data dir as of a date")
    add_common(r)
    r.add_argument("--date", required=True)
    r.add_argument("--out", required=True, help="empty directory to restore into")
    r.set_defaults(func=cmd_restore)
    return p


def main(argv: Optional[Iterable[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] not in ("backup", "restore", "-h", "--help"):
        argv.insert(0, "backup")
    args = build_parser().parse_args(argv)
    if args.cmd is None:
        build_parser().print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
