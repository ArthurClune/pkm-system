# pattern: Imperative Shell
"""Materialise the perf fixture into a SQLite DB through the real write path.

Ops go through ops_apply.apply_batch -- the same function POST /api/ops
uses -- so triggers fill blocks_fts, refs, block_refs and changes exactly as
in prod. Two keys, on purpose: `cache_key` (generator + DDL) decides when the
cached DB is rebuilt; `fixture_hash` (generator only) decides whether two
runs are comparable, so a schema change is measured against the baseline
rather than excused from it."""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from pkm.contracts.ops import OpBatch
from pkm.schema import DDL
from pkm.server.db import init_db, open_db
from pkm.server.ops_apply import apply_batch

from perfcheck import fixture as _fixture_mod
from perfcheck.fixture import generate

_FIXTURE_SRC = Path(_fixture_mod.__file__).read_bytes()


def fixture_hash() -> str:
    return hashlib.sha256(_FIXTURE_SRC).hexdigest()[:16]


def cache_key(seed: int, scale: float) -> str:
    h = hashlib.sha256()
    for part in (_FIXTURE_SRC, DDL.encode(), f"{seed}:{scale}".encode()):
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


def cached_fixture(seed: int = 1, scale: float = 1.0) -> Path:
    target = cache_dir() / f"fixture-{cache_key(seed, scale)}.sqlite3"
    if target.exists():
        return target
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
    return target
