import sqlite3
from contextlib import contextmanager

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
            "assets/search", "sync/snapshot", "ops/edit-1",
            "ops/edit-hashed-clean", "ops/edit-hashed-identical",
            "ops/edit-hashed-conflict", "ops/edit-rename-replay",
            "ops/edit-missing-block", "ops/create-missing-parent",
            "ops/move-missing-parent", "ops/paste-50",
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


@contextmanager
def _run_scenario(small_fixture, name):
    """Apply one named write scenario to a fresh copy and yield a connection
    to the result for the caller to inspect -- verifies which ops_core
    branch actually ran, not just that a count came back."""
    lm = backend.generate(1, 0.02).landmarks
    s = next(x for x in backend.scenarios(lm, 0) if x.name == name)
    env = backend._Env(small_fixture)
    try:
        r = backend._call(env.client, s)
        assert r.status_code == 200, r.text
        con = sqlite3.connect(env.db)
        try:
            yield con
        finally:
            con.close()
    finally:
        env.close()


def test_hashed_clean_edit_lands_the_new_text(small_fixture):
    from perfcheck.fixture import HASHED_EDIT_TEXT

    lm = backend.generate(1, 0.02).landmarks
    with _run_scenario(small_fixture, "ops/edit-hashed-clean") as con:
        text = con.execute("SELECT text FROM blocks WHERE uid = ?",
                           (lm.hashed_edit_uid,)).fetchone()[0]
        assert text == HASHED_EDIT_TEXT + " (clean edit)"
        # a clean apply never lands a conflict entry
        assert con.execute("SELECT COUNT(*) FROM conflict_headers").fetchone()[0] == 0


def test_hashed_identical_edit_is_a_true_noop(small_fixture):
    from perfcheck.fixture import HASHED_EDIT_TEXT

    lm = backend.generate(1, 0.02).landmarks
    before = sqlite3.connect(small_fixture)
    try:
        updated_at_before = before.execute(
            "SELECT updated_at FROM blocks WHERE uid = ?",
            (lm.hashed_edit_uid,)).fetchone()[0]
    finally:
        before.close()
    with _run_scenario(small_fixture, "ops/edit-hashed-identical") as con:
        text, updated_at = con.execute(
            "SELECT text, updated_at FROM blocks WHERE uid = ?",
            (lm.hashed_edit_uid,)).fetchone()
        assert text == HASHED_EDIT_TEXT
        assert updated_at == updated_at_before  # check 2: no write at all


def test_hashed_conflict_lands_the_loser_and_keeps_the_winner(small_fixture):
    from perfcheck.fixture import HASHED_EDIT_TEXT

    lm = backend.generate(1, 0.02).landmarks
    with _run_scenario(small_fixture, "ops/edit-hashed-conflict") as con:
        text = con.execute("SELECT text FROM blocks WHERE uid = ?",
                           (lm.hashed_edit_uid,)).fetchone()[0]
        assert text == HASHED_EDIT_TEXT + " (stale offline edit)"  # incoming wins
        headers = con.execute("SELECT target_uid FROM conflict_headers").fetchall()
        assert headers == [(lm.hashed_edit_uid,)]
        lost = con.execute(
            "SELECT text FROM blocks WHERE parent_uid IN"
            " (SELECT header_uid FROM conflict_headers)").fetchall()
        assert lost == [(HASHED_EDIT_TEXT,)]  # the old text, preserved


def test_rename_replay_applies_cleanly_onto_the_renamed_text(small_fixture):
    from perfcheck.fixture import RENAME_REF_TEXT, RENAME_TARGET_TITLE

    lm = backend.generate(1, 0.02).landmarks
    with _run_scenario(small_fixture, "ops/edit-rename-replay") as con:
        text = con.execute("SELECT text FROM blocks WHERE uid = ?",
                           (lm.rename_ref_uid,)).fetchone()[0]
        expected = (RENAME_REF_TEXT.replace("Perf Rename Source", RENAME_TARGET_TITLE)
                    + " (offline edit predating the rename)")
        assert text == expected
        # replayed cleanly, not as a conflict
        assert con.execute("SELECT COUNT(*) FROM conflict_headers").fetchone()[0] == 0


def test_edit_missing_block_lands_an_orphan_entry(small_fixture):
    from perfcheck.fixture import MISSING_BLOCK_UID

    with _run_scenario(small_fixture, "ops/edit-missing-block") as con:
        assert con.execute("SELECT COUNT(*) FROM blocks WHERE uid = ?",
                           (MISSING_BLOCK_UID,)).fetchone()[0] == 0
        headers = con.execute("SELECT target_uid FROM conflict_headers").fetchall()
        assert headers == [(MISSING_BLOCK_UID,)]
        lost = con.execute(
            "SELECT text FROM blocks WHERE parent_uid IN"
            " (SELECT header_uid FROM conflict_headers)").fetchone()[0]
        assert lost == "orphaned edit, block already gone"


def test_create_missing_parent_diverts_the_text(small_fixture):
    from perfcheck.fixture import MISSING_PARENT_UID

    with _run_scenario(small_fixture, "ops/create-missing-parent") as con:
        assert con.execute("SELECT COUNT(*) FROM blocks WHERE parent_uid = ?",
                           (MISSING_PARENT_UID,)).fetchone()[0] == 0
        headers = con.execute("SELECT target_uid FROM conflict_headers").fetchall()
        assert headers == [(MISSING_PARENT_UID,)]
        lost = con.execute(
            "SELECT text FROM blocks WHERE parent_uid IN"
            " (SELECT header_uid FROM conflict_headers)").fetchone()[0]
        assert lost == "diverted create, parent already gone"


def test_move_missing_parent_journals_the_subtree(small_fixture):
    from perfcheck.fixture import MISSING_PARENT_UID

    lm = backend.generate(1, 0.02).landmarks
    before = sqlite3.connect(small_fixture)
    try:
        parent_before = before.execute(
            "SELECT parent_uid FROM blocks WHERE uid = ?", (lm.move_uid,)).fetchone()[0]
    finally:
        before.close()
    with _run_scenario(small_fixture, "ops/move-missing-parent") as con:
        # the block stays exactly where it was: the move never applied
        parent = con.execute("SELECT parent_uid FROM blocks WHERE uid = ?",
                             (lm.move_uid,)).fetchone()[0]
        assert parent == parent_before
        assert parent != MISSING_PARENT_UID
        headers = con.execute("SELECT target_uid FROM conflict_headers").fetchall()
        assert headers == [(lm.move_uid,)]
        n_journalled = con.execute(
            "SELECT COUNT(*) FROM changes WHERE entity_id = ?",
            (lm.move_uid,)).fetchone()[0]
        assert n_journalled >= 1


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
