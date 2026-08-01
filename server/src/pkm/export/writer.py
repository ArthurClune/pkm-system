# pattern: Imperative Shell
"""Write the full markdown + assets export for a graph database.

Rendering and asset staging happen entirely in a scratch directory beside
the live one; the last good export is only replaced once a full new export
is ready, via atomic directory renames (see `_publish_dir`). A crash or
exception anywhere in rendering, disk I/O, or asset copying -- before any
`_publish_dir` call runs -- leaves the previous export byte-identical:
nothing is deleted or overwritten in-place.

Publishing itself is three separate atomic renames (pages/, journal/,
assets/ in turn), not one transaction across all three: if a later one
fails after an earlier one already landed (e.g. `_publish_dir(journal)`
raising after `_publish_dir(pages)` succeeded), this run's export is left
in a genuine mixed old/new state -- not byte-identical to before -- until
the next successful run's per-subtree self-heal (see `_publish_dir`)
converges it back to fully consistent. Nothing is ever corrupted or
silently lost in that window (the old content of each not-yet-published
subtree survives under `<name>.stale` until superseded), and the raised
exception means the nightly backup job (`pkm.backup.__main__`) exits
nonzero and never reaches `git_commit_export` -- so this mixed state is
never the thing that gets committed to the export's git history.

*.md files are wholly regenerated every run (git still diffs minimally
because unchanged content is byte-identical). The asset mirror is
incremental: content-hashed files never change, so an asset already present
in the export is hardlinked into the new tree instead of re-copied; only
new hashes are actually copied from the live store, and vanished hashes are
simply left out of the new tree (pruned).

An asset already present is only hardlinked after it passes verification
against the assets row's known sha256/size (pkm-x3l7): a cheap stat-based
size check first, and only once that matches, a full sha256 of its bytes.
A file that fails either check is never hardlinked forward -- the loop
falls through to the same branch used for a brand-new hash and re-copies
correct bytes from `live_assets_dir`, so a corrupted "existing" asset is
transparently repaired by the time this run's `_publish_dir(stage_assets,
assets_dir)` lands. Hashing the whole previously-present set every run
costs a full read of each file, but at this graph's scale (order ~1e3
images) that's a low-single-digit-second tax on a nightly job, not
something worth a sampling scheme -- see assets_core.asset_needs_repair
for where the size check saves a read outright."""
from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

from pkm.assets_core import asset_needs_repair, sha256_hex
from pkm.export.markdown import page_filename, render_page
from pkm.filenames import safe_filename
from pkm.server.daily import date_for_title
from pkm.server.tree import build_tree, collect_block_ref_uids

GITIGNORE = "assets/\n.export-staging-*/\n"


def _publish_dir(staged: Path, target: Path) -> None:
    """Atomically replace `target`'s contents with `staged`'s.

    A plain `os.replace(staged, target)` fails when `target` is a
    non-empty directory, so the previous contents are first moved aside
    (a second atomic rename) and only removed once the new contents are
    in place. That leaves, at most, a brief window where `target` doesn't
    exist -- never a window where it holds partial contents.
    """
    stale = target.with_name(target.name + ".stale")
    if stale.exists():
        shutil.rmtree(stale)
    if target.exists():
        os.replace(target, stale)
    os.replace(staged, target)
    if stale.exists():
        shutil.rmtree(stale)


def export_graph(db: sqlite3.Connection, live_assets_dir: Path,
                 export_dir: Path) -> dict:
    pages_dir = export_dir / "pages"
    journal_dir = export_dir / "journal"
    assets_dir = export_dir / "assets"
    export_dir.mkdir(parents=True, exist_ok=True)
    (export_dir / ".gitignore").write_text(GITIGNORE, encoding="utf-8")

    texts = [r["text"] for r in db.execute("SELECT text FROM blocks")]
    uid_to_text: dict[str, str] = {}
    for uid in collect_block_ref_uids(texts):
        row = db.execute("SELECT text FROM blocks WHERE uid = ?",
                         (uid,)).fetchone()
        if row is not None:
            uid_to_text[uid] = row["text"]

    counts = {"pages": 0, "journal": 0, "assets_copied": 0, "assets_pruned": 0}
    rendered: dict[tuple[str, str], str] = {}  # (kind, filename) -> body
    taken: set[str] = set()
    for page in db.execute("SELECT id, title FROM pages ORDER BY title"):
        rows = db.execute(
            "SELECT uid, parent_uid, order_idx, text, heading, collapsed,"
            " created_at, updated_at, view_type FROM blocks WHERE page_id = ?",
            (page["id"],)).fetchall()
        body = render_page(page["title"], build_tree(rows), uid_to_text)
        day = date_for_title(page["title"])
        if day is not None:
            rendered["journal", f"{day.isoformat()}.md"] = body
            counts["journal"] += 1
        else:
            rendered["pages", page_filename(page["title"], taken)] = body
            counts["pages"] += 1

    wanted: dict[str, tuple[str, int]] = {
        row["sha256"]: (safe_filename(row["filename"]), row["size"])
        for row in db.execute("SELECT sha256, filename, size FROM assets")}
    previously_present = ({d.name for d in assets_dir.iterdir() if d.is_dir()}
                          if assets_dir.is_dir() else set())
    counts["assets_pruned"] = len(previously_present - wanted.keys())

    staging = Path(tempfile.mkdtemp(dir=export_dir, prefix=".export-staging-"))
    try:
        stage_pages, stage_journal, stage_assets = (
            staging / "pages", staging / "journal", staging / "assets")
        stage_pages.mkdir()
        stage_journal.mkdir()
        stage_assets.mkdir()
        for (kind, fname), body in rendered.items():
            (staging / kind / fname).write_text(body, encoding="utf-8")

        for sha, (fname, size) in wanted.items():
            dest = stage_assets / sha / fname
            existing = assets_dir / sha / fname
            if existing.is_file():
                actual_size = existing.stat().st_size
                actual_sha = (sha256_hex(existing.read_bytes())
                             if actual_size == size else None)
                if not asset_needs_repair(sha, size, actual_size, actual_sha):
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    os.link(existing, dest)
                    continue
            src = live_assets_dir / sha[:2] / sha
            if not src.is_file():
                continue  # row without a stored file: known import residue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            counts["assets_copied"] += 1

        # Publish only now that every render and copy above has succeeded.
        # Each call is atomic on its own, but the three together are not
        # one transaction -- see the module docstring for what a failure
        # partway through this sequence does and doesn't guarantee.
        _publish_dir(stage_pages, pages_dir)
        _publish_dir(stage_journal, journal_dir)
        _publish_dir(stage_assets, assets_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return counts
