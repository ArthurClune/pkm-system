import sqlite3

import pytest

from perfcheck import build as b
from perfcheck.fixture import generate


@pytest.fixture()
def cache(tmp_path, monkeypatch):
    monkeypatch.setenv("PKM_PERF_CACHE", str(tmp_path / "cache"))
    return tmp_path / "cache"


def test_build_applies_every_create(tmp_path):
    dest = tmp_path / "fx.sqlite3"
    b.build(dest, seed=1, scale=0.02)
    fx = generate(1, 0.02)
    n_creates = sum(1 for bt in fx.batches for op in bt.ops if op["op"] == "create")
    con = sqlite3.connect(dest)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == n_creates
    assert con.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == len(fx.assets)
    assert con.execute("SELECT COUNT(*) FROM sidebar_entries").fetchone()[0] == len(fx.sidebar)
    # triggers ran: FTS and the change journal are populated
    assert con.execute("SELECT COUNT(*) FROM blocks_fts").fetchone()[0] == n_creates
    assert con.execute("SELECT COUNT(*) FROM changes").fetchone()[0] > 0
    assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_cached_fixture_reuses_file(cache):
    p1 = b.cached_fixture(1, 0.02)
    mtime = p1.stat().st_mtime_ns
    p2 = b.cached_fixture(1, 0.02)
    assert p1 == p2 and p2.stat().st_mtime_ns == mtime
    assert p1.parent == cache


def test_cache_key_tracks_ddl_but_fixture_hash_does_not(monkeypatch):
    k1, h1 = b.cache_key(1, 1.0), b.fixture_hash()
    monkeypatch.setattr(b, "DDL", b.DDL + "\n-- changed")
    assert b.cache_key(1, 1.0) != k1
    assert b.fixture_hash() == h1


def test_failed_build_leaves_no_cache_file(cache, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(b, "apply_batch", boom)
    with pytest.raises(RuntimeError):
        b.cached_fixture(1, 0.02)
    assert not list(cache.glob("*.sqlite3"))
