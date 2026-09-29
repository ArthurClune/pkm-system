"""pkm-gwwu: post_ops's dedupe read and the batch's context reads must not
run in a window a concurrent delete_page/rename_page/cleanup_journal commit
can land inside. These tests race a second connection against the batch's
own transaction, deterministically, by monkeypatching a function
apply_batch calls internally and opening the second connection from
inside that patch (the same technique test_ops_idempotency.py already uses
for the applied_batches insert race)."""
import sqlite3

import pytest


def test_concurrent_page_delete_cannot_land_inside_the_batch(
        client, seeded_config, monkeypatch):
    from pkm.server import ops_apply
    from pkm.server.db import open_db
    from pkm.server.store import delete_page_rows, fetch_page

    real_context_for = ops_apply._context_for

    def racing(db, op, now_ms):
        ctx = real_context_for(db, op, now_ms)  # sees uid_b6 still on "AI"
        con2 = open_db(seeded_config.db_path)
        con2.execute("PRAGMA busy_timeout=50")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            page = fetch_page(con2, "AI")
            delete_page_rows(con2, page["id"], "AI")
        con2.close()
        return ctx

    monkeypatch.setattr(ops_apply, "_context_for", racing)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "gwwu-delete-race",
        "ops": [{"op": "update_text", "uid": "uid_b6",
                 "text": "typed during delete"}]})
    assert r.status_code == 200
    page = client.get("/api/page/AI").json()
    assert any(b["text"] == "typed during delete" for b in page["blocks"])


def test_concurrent_rename_cannot_resurrect_the_old_title(
        client, seeded_config, monkeypatch):
    from pkm.server import ops_apply
    from pkm.server.db import open_db
    from pkm.server.store import fetch_page, rename_page_rows

    real_hint_page_exists = ops_apply._hint_page_exists

    def racing(db, page_title):
        exists = real_hint_page_exists(db, page_title)  # True: not renamed yet
        con2 = open_db(seeded_config.db_path)
        con2.execute("PRAGMA busy_timeout=50")
        page = fetch_page(con2, "Machine Learning")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            rename_page_rows(con2, page["id"], "Machine Learning",
                             "ML Renamed", 1_800_000_000_000)
        con2.close()
        return exists

    monkeypatch.setattr(ops_apply, "_hint_page_exists", racing)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "gwwu-rename-race",
        "ops": [{"op": "update_text", "uid": "uid_zz_renamed",
                 "text": "typed during rename",
                 "page_title": "Machine Learning"}]})
    assert r.status_code == 200
    con = open_db(seeded_config.db_path)
    row = con.execute(
        "SELECT 1 FROM pages WHERE title = 'Machine Learning'").fetchone()
    con.close()
    assert row is not None  # the race never landed: nothing to resurrect


def test_lock_contention_on_begin_immediate_returns_503(
        client, seeded_config, monkeypatch):
    from pkm.server import db as db_module

    monkeypatch.setattr(db_module, "BUSY_TIMEOUT_MS", 50)
    blocker = db_module.open_db(seeded_config.db_path)
    blocker.execute("BEGIN IMMEDIATE")  # takes the write lock and holds it
    try:
        r = client.post("/api/ops", json={
            "client_id": "c1", "batch_id": "gwwu-503-race",
            "ops": [{"op": "update_text", "uid": "uid_b1", "text": "x"}]})
        assert r.status_code == 503
        assert r.headers["retry-after"] == "1"
    finally:
        blocker.commit()
        blocker.close()
