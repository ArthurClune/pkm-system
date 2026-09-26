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


def test_counts_are_deterministic_across_runs(small_fixture, result):
    again = backend.run(small_fixture, repeats=1, scale=0.02)

    def strip(r):
        return {s: {k: v for k, v in m.items() if v["class"] != "timing"}
                for s, m in r["scenarios"].items()}
    assert strip(again) == strip(result)


def test_writes_hit_a_fresh_copy(small_fixture, result):
    # the paste scenario's statement count would grow run to run if writes
    # accumulated in the cached fixture
    import sqlite3
    con = sqlite3.connect(small_fixture)
    assert con.execute("SELECT COUNT(*) FROM blocks WHERE uid LIKE 'pp%'").fetchone()[0] == 0


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
