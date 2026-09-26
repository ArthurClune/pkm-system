import pytest

from perfcheck import backend
from perfcheck.build import build


@pytest.fixture(scope="module")
def small_fixture(tmp_path_factory):
    dest = tmp_path_factory.mktemp("fx") / "fx.sqlite3"
    build(dest, seed=1, scale=0.02)
    return dest


@pytest.fixture(scope="module")
def result(small_fixture):
    return backend.run(small_fixture, repeats=1, scale=0.02)


def test_every_scenario_measured(result):
    names = set(result["scenarios"])
    assert {"page/big", "page/hub", "journal/head", "search/common", "search/rare",
            "search/prefix", "search/phrase", "search/many-hits", "search/title",
            "assets/search", "sync/snapshot", "ops/edit-1", "ops/paste-50",
            "ops/move-subtree", "rename/hub"} <= names
    for name, m in result["scenarios"].items():
        assert m["statements"]["class"] == "exact", name
        assert m["statements"]["value"] >= 1, name
        assert m["bytes"]["value"] > 0, name
        assert m["median_ms"]["class"] == "timing", name


def test_aliased_table_scans_are_counted(result):
    # todos/all reads `FROM blocks b ... WHERE instr(b.text, 'TODO') > 0`,
    # which plans as `SCAN b`: the alias, not the table name
    assert result["scenarios"]["todos/all"]["full_scans"]["value"] >= 1


def test_unplannable_statement_fails_loudly(monkeypatch, small_fixture):
    real = backend.Tracer.stop

    def poisoned(self):
        tally = real(self)
        tally.statements.append("SELECT * FROM no_such_table")
        return tally
    monkeypatch.setattr(backend.Tracer, "stop", poisoned)
    with pytest.raises(RuntimeError, match=r"page/big.*no_such_table"):
        backend.run(small_fixture, only={"page/big"}, repeats=1, scale=0.02)


def test_counts_are_deterministic_across_runs(small_fixture, result):
    again = backend.run(small_fixture, repeats=1, scale=0.02)

    def strip(r):
        return {s: {k: v for k, v in m.items() if v["class"] != "timing"}
                for s, m in r["scenarios"].items()}
    assert strip(again) == strip(result)


def test_writes_hit_a_fresh_copy(small_fixture):
    # running the same write scenario's counted call twice must not leave
    # the second run's inserts piled on top of the first's -- it would if
    # _Env.fresh() were skipped or broken
    import sqlite3
    lm = backend.generate(1, 0.02).landmarks
    paste = next(s for s in backend.scenarios(lm, 0) if s.name == "ops/paste-50")
    env = backend._Env(small_fixture)
    try:
        backend._count_once(env, paste, set())
        backend._count_once(env, paste, set())
        con = sqlite3.connect(env.db)
        try:
            n = con.execute("SELECT COUNT(*) FROM blocks WHERE uid LIKE 'pp%'").fetchone()[0]
        finally:
            con.close()
        assert n == 50
    finally:
        env.close()
    # the shared, cached fixture file itself must never be written to
    con = sqlite3.connect(small_fixture)
    try:
        assert con.execute("SELECT COUNT(*) FROM blocks WHERE uid LIKE 'pp%'").fetchone()[0] == 0
    finally:
        con.close()


def test_read_after_write_without_a_fresh_copy_fails_loudly(small_fixture):
    lm = backend.generate(1, 0.02).landmarks
    write_s = next(s for s in backend.scenarios(lm, 0) if s.name == "ops/edit-1")
    read_s = next(s for s in backend.scenarios(lm, 0) if s.name == "page/big")
    env = backend._Env(small_fixture)
    try:
        backend._count_once(env, write_s, set())
        with pytest.raises(backend.DirtyReadError, match="page/big"):
            backend._count_once(env, read_s, set())
    finally:
        env.close()


def test_env_init_cleans_up_its_tempdir_when_make_client_raises(monkeypatch, small_fixture, tmp_path):
    made = tmp_path / "leaked-env-dir"
    made.mkdir()
    monkeypatch.setattr(backend.tempfile, "mkdtemp", lambda prefix=None: str(made))
    monkeypatch.setattr(backend, "make_client",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError, match="boom"):
        backend._Env(small_fixture)
    assert not made.exists()


def test_cached_fixture_is_opened_read_only(monkeypatch, small_fixture):
    # the cached fixture is shared across sessions; only private copies are written
    real, opened = backend.sqlite3.connect, []

    def spy(target, *a, **k):
        opened.append((str(target), k.get("uri", False)))
        return real(target, *a, **k)
    monkeypatch.setattr(backend.sqlite3, "connect", spy)
    backend.run(small_fixture, only={"page/big"}, repeats=1, scale=0.02)
    direct = [(t, uri) for t, uri in opened if small_fixture.name in t
              and str(small_fixture.parent.name) in t]
    assert direct and all(uri and "?mode=ro" in t for t, uri in direct), direct


def test_trace_sees_expanded_sql(small_fixture):
    from perfcheck.trace import Tracer
    t = Tracer()
    client = backend.make_client(small_fixture, t)
    t.start()
    client.get("/api/search", params={"q": "project"})
    tally = t.stop()
    assert any("'project" in s or '"project' in s for s in tally.statements), tally.statements


def test_result_document_shape(result):
    assert set(result) == {"commit", "fixture_hash", "env", "scenarios"}
    assert set(result["env"]) == {"python", "sqlite"}


def test_counted_runs_agree(monkeypatch, small_fixture):
    calls = {"n": 0}
    real = backend._count_once

    def flaky(*a, **k):
        calls["n"] += 1
        out = real(*a, **k)
        if calls["n"] == 2:
            out = {**out, "statements": out["statements"] + 1}
        return out
    monkeypatch.setattr(backend, "_count_once", flaky)
    with pytest.raises(backend.UnstableCountError, match="page/big"):
        backend.run(small_fixture, only={"page/big"}, repeats=1, scale=0.02)
