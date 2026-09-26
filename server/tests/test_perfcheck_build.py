import fcntl
import os
import sqlite3
import time

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


def test_cached_fixture_reuses_file(cache, monkeypatch):
    p1 = b.cached_fixture(1, 0.02)
    inode = p1.stat().st_ino
    monkeypatch.setattr(b, "build", lambda *a, **k: pytest.fail("rebuilt a cached fixture"))
    p2 = b.cached_fixture(1, 0.02)
    assert p1 == p2 and p2.stat().st_ino == inode
    assert p1.parent == cache


def test_cache_key_tracks_ddl_but_fixture_hash_does_not(monkeypatch):
    k1, h1 = b.cache_key(1, 1.0), b.fixture_hash()
    monkeypatch.setattr(b, "DDL", b.DDL + "\n-- changed")
    assert b.cache_key(1, 1.0) != k1
    assert b.fixture_hash() == h1


def test_cache_key_tracks_product_source(tmp_path, monkeypatch):
    # refs and block_refs are written by Python in the product's write path,
    # not by triggers, so a product change must rebuild the fixture
    (tmp_path / "server").mkdir()
    src = tmp_path / "server" / "store.py"
    src.write_text("x = 1\n")
    monkeypatch.setattr(b, "_PRODUCT_ROOT", tmp_path)
    k1, h1 = b.cache_key(1, 1.0), b.fixture_hash()
    src.write_text("x = 2\n")
    assert b.cache_key(1, 1.0) != k1
    src.write_text("x = 1\n")
    assert b.cache_key(1, 1.0) == k1
    src.rename(tmp_path / "store.py")  # same bytes, different module
    assert b.cache_key(1, 1.0) != k1
    assert b.fixture_hash() == h1


def test_cache_key_parts_are_delimited(monkeypatch):
    monkeypatch.setattr(b, "_FIXTURE_SRC", b"ab")
    monkeypatch.setattr(b, "DDL", "c")
    k1 = b.cache_key(1, 1.0)
    monkeypatch.setattr(b, "_FIXTURE_SRC", b"a")
    monkeypatch.setattr(b, "DDL", "bc")
    assert b.cache_key(1, 1.0) != k1


def _age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def test_cached_fixture_prunes_unused_fixtures_and_orphaned_temps(cache):
    cache.mkdir()
    day = 86_400
    for name, age in [("fixture-old.sqlite3", 8 * day), ("fixture-old.sqlite3-wal", 8 * day),
                      ("fixture-recent.sqlite3", 2 * day),
                      ("tmporphan.sqlite3", 2 * 3600), ("tmporphan.sqlite3-shm", 2 * 3600),
                      ("tmpfresh.sqlite3", 0)]:
        (cache / name).write_bytes(b"")
        _age(cache / name, age)
    target = b.cached_fixture(1, 0.02)
    left = sorted(p.name for p in cache.glob("*.sqlite3*"))
    assert left == sorted(["fixture-recent.sqlite3", "tmpfresh.sqlite3", target.name])
    # a reused fixture counts as used now, so it is never the stale one
    _age(target, 30 * day)
    b.cached_fixture(1, 0.02)
    assert time.time() - target.stat().st_mtime < 60


def test_cache_lock_fails_naming_the_holder_after_waiting(cache, monkeypatch):
    cache.mkdir()
    monkeypatch.setattr(b, "LOCK_WAIT_S", 0)
    with (cache / "cache.lock").open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(b.CacheLockTimeout, match="the fixture cache"):
            with b.cache_lock("cache", "the fixture cache"):
                pytest.fail("took a held lock")
    with b.cache_lock("cache", "the fixture cache"):
        pass  # released with the holder's file


def test_failed_build_leaves_no_cache_file(cache, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(b, "apply_batch", boom)
    with pytest.raises(RuntimeError):
        b.cached_fixture(1, 0.02)
    assert not list(cache.glob("*.sqlite3"))
