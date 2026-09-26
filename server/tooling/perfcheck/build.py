# pattern: Imperative Shell
"""Materialise the perf fixture into a SQLite DB through the real write path.

Ops go through ops_apply.apply_batch -- the same function POST /api/ops
uses -- so the derived tables come out exactly as in prod: triggers fill
blocks_fts and changes, and the product's Python (store.reindex_refs_for_text)
fills refs and block_refs. Two keys, on purpose: `cache_key` (generator +
DDL + product source) decides when the cached DB is rebuilt, so a change to
the write path rebuilds it; `fixture_hash` (generator only) decides whether
two runs are comparable, so a schema or product change is measured against
the baseline rather than excused from it.

The cache dir is shared by every worktree and session on the machine, so
its writes happen under `cache_lock`, and entries unused for about a week
are pruned."""
from __future__ import annotations

import fcntl
import hashlib
import os
import sys
import tempfile
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pkm
from pkm.contracts.ops import OpBatch
from pkm.schema import DDL
from pkm.server.db import init_db, open_db
from pkm.server.ops_apply import apply_batch

from perfcheck import fixture as _fixture_mod
from perfcheck.fixture import generate
from perfcheck.run_core import stale_entries

_FIXTURE_SRC = Path(_fixture_mod.__file__).read_bytes()
# the product in whichever venv runs this: a merge-base run hashes the base's
_PRODUCT_ROOT = Path(pkm.__file__).parent

LOCK_WAIT_S = 20 * 60  # a frontend confirmation takes minutes, not this long
UNUSED_FOR_S = 7 * 86_400  # a run marks what it uses; no run lasts this long
ORPHAN_AFTER_S = 3600  # builds take seconds under the lock; older temps are dead


class CacheLockTimeout(RuntimeError):
    pass


@contextmanager
def cache_lock(name: str, holder: str) -> Iterator[None]:
    """Exclusive flock on `cache_dir()/<name>.lock`, machine-wide. Waits,
    saying so, while another perf check holds it; the OS drops the lock if
    the holder dies."""
    path = cache_dir() / f"{name}.lock"
    with path.open("a") as fh:
        deadline = time.monotonic() + LOCK_WAIT_S
        waiting = False
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise CacheLockTimeout(
                        f"another perf check still holds {holder} ({path}) "
                        f"after {LOCK_WAIT_S} s") from None
                if not waiting:
                    print(f"perf: another perf check holds {holder}; waiting for {path}",
                          file=sys.stderr, flush=True)
                    waiting = True
                time.sleep(1)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def fixture_hash() -> str:
    return hashlib.sha256(_FIXTURE_SRC).hexdigest()[:16]


def _source_digest(root: Path) -> bytes:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*.py")):
        for part in (p.relative_to(root).as_posix().encode(), p.read_bytes()):
            h.update(len(part).to_bytes(8, "big"))
            h.update(part)
    return h.digest()


def cache_key(seed: int, scale: float) -> str:
    h = hashlib.sha256()
    for part in (_FIXTURE_SRC, DDL.encode(), _source_digest(_PRODUCT_ROOT),
                 f"{seed}:{scale}".encode()):
        h.update(len(part).to_bytes(8, "big"))  # delimits the parts
        h.update(part)
    return h.hexdigest()[:16]


def cache_dir() -> Path:
    d = Path(os.environ.get("PKM_PERF_CACHE", Path.home() / ".cache" / "pkm-perf"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def build(dest: Path, seed: int = 1, scale: float = 1.0) -> None:
    fx = generate(seed, scale)
    init_db(dest)
    con = open_db(dest)
    try:
        for i, batch in enumerate(fx.batches):
            ob = OpBatch.model_validate({"client_id": "perf-fixture",
                                         "batch_id": f"fixture-{i:06d}",
                                         "ops": list(batch.ops)})
            apply_batch(con, ob, batch.now_ms)
            con.commit()
        con.executemany(
            "INSERT INTO assets(sha256, filename, mime, size, created_at, description)"
            " VALUES (?,?,?,?,?,?)",
            [(a.sha256, a.filename, a.mime, a.size, a.created_at, a.description) for a in fx.assets])
        con.executemany("INSERT INTO sidebar_entries(title, order_idx) VALUES (?,?)",
                        [(t, i) for i, t in enumerate(fx.sidebar)])
        con.commit()
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        con.close()


def _build_into(target: Path, seed: int, scale: float) -> None:
    fd, tmp_name = tempfile.mkstemp(suffix=".sqlite3", dir=target.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    tmp.unlink()  # init_db wants to create it
    try:
        build(tmp, seed, scale)
        tmp.replace(target)
    finally:
        for p in (tmp, Path(f"{tmp}-wal"), Path(f"{tmp}-shm")):
            p.unlink(missing_ok=True)


def _mtimes(paths: Iterable[Path]) -> dict[str, float]:
    return {p.name: p.stat().st_mtime for p in paths}


def _prune(d: Path, keep: Path) -> None:
    """Fixtures unused for about a week, and temp DBs a killed build left."""
    now = time.time()
    fixtures = stale_entries(_mtimes(d.glob("fixture-*.sqlite3")), now, {keep.name}, UNUSED_FOR_S)
    for name in fixtures:
        for suffix in ("", "-wal", "-shm"):
            (d / f"{name}{suffix}").unlink(missing_ok=True)
    for name in stale_entries(_mtimes(d.glob("tmp*.sqlite3*")), now, set(), ORPHAN_AFTER_S):
        (d / name).unlink(missing_ok=True)


def cached_fixture(seed: int = 1, scale: float = 1.0) -> Path:
    target = cache_dir() / f"fixture-{cache_key(seed, scale)}.sqlite3"
    with cache_lock("cache", "the fixture cache"):
        if not target.exists():
            _build_into(target, seed, scale)
        os.utime(target)  # the use marker _prune reads
        _prune(target.parent, target)
    return target
