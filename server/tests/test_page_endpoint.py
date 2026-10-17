import sqlite3
from datetime import date, timedelta
from urllib.parse import quote

import pytest

from rawread import read
from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import text_hash


def test_get_past_daily_404s_and_creates_nothing(client):
    yesterday = title_for_date(date.today() - timedelta(days=1))
    assert client.get(f"/api/page/{yesterday}").status_code == 404
    # a second GET still 404s: the first one must not have created a row
    assert client.get(f"/api/page/{yesterday}").status_code == 404


def test_get_today_still_autocreates(client):
    today = title_for_date(date.today())
    r = client.get(f"/api/page/{today}")
    assert r.status_code == 200
    assert r.json()["page"]["title"] == today


def test_page_tree_shape(client):
    r = client.get("/api/page/Machine Learning")
    assert r.status_code == 200
    body = r.json()
    assert body["page"]["title"] == "Machine Learning"
    assert body["page"]["created_at"] == 1000
    texts = [b["text"] for b in body["blocks"]]
    assert texts == ["Tags:: #AI", "Papers"]
    papers = body["blocks"][1]
    assert papers["heading"] == 2
    assert papers["view_type"] is None
    assert [c["text"] for c in papers["children"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]"]


def test_block_ref_resolution(client):
    r = client.get("/api/page/July 7th, 2026")
    assert r.status_code == 200
    body = r.json()
    assert body["block_ref_texts"] == {
        "uid_b3": {"text": "[[Attention Is All You Need]] is a [[Paper]]",
                   "page_title": "Machine Learning"},
    }


def test_block_ref_resolution_is_transitive(client, seeded_config):
    # uid_n1's text is itself just a ((ref)) to uid_n2: the client renders
    # uid_n1's text and needs uid_n2 in the map too (nested expansion).
    import sqlite3
    con = sqlite3.connect(seeded_config.db_path)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", [
        ("uid_n0", 2, None, 1, "c.f. ((uid_n1))", None, 0, None, None),
        ("uid_n1", 1, None, 2, "((uid_n2))", None, 0, None, None),
        ("uid_n2", 4, None, 0, "the actual content", None, 0, None, None),
        ])
    con.commit()
    con.close()

    body = client.get("/api/page/AI").json()
    assert body["block_ref_texts"] == {
        "uid_n1": {"text": "((uid_n2))", "page_title": "Machine Learning"},
        "uid_n2": {"text": "the actual content", "page_title": "Paper"},
    }


def test_block_ref_resolution_survives_cycles(client, seeded_config):
    # Mutually-referencing blocks must not hang resolution.
    import sqlite3
    con = sqlite3.connect(seeded_config.db_path)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", [
        ("uid_c0", 2, None, 1, "start ((uid_c1))", None, 0, None, None),
        ("uid_c1", 4, None, 0, "a ((uid_c2))", None, 0, None, None),
        ("uid_c2", 4, None, 1, "b ((uid_c1)) and ((uid_gone))", None, 0, None, None),
        ])
    con.commit()
    con.close()

    body = client.get("/api/page/AI").json()
    assert body["block_ref_texts"] == {
        "uid_c1": {"text": "a ((uid_c2))", "page_title": "Paper"},
        "uid_c2": {"text": "b ((uid_c1)) and ((uid_gone))",
                   "page_title": "Paper"},
    }


def test_missing_page_404(client):
    assert client.get("/api/page/No Such Page").status_code == 404


def test_missing_daily_page_auto_creates(client):
    title = title_for_date(date.today())
    r = client.get(f"/api/page/{title}")
    assert r.status_code == 200
    assert r.json()["page"]["title"] == title
    assert r.json()["blocks"] == []
    # created persistently, not per-request
    assert client.get(f"/api/page/{title}").status_code == 200


def test_namespace_title_with_slash(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(id,title) VALUES (99,'AWS/SCP')")
    con.commit()
    con.close()
    assert client.get("/api/page/AWS/SCP").status_code == 200


def test_get_page_normalizes_routable_control_whitespace(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, "Ctrl Title", 100, 100),
    )
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_ctrl_read", 99, None, 0, "page body", None, 0, None, None),
    )
    con.commit()
    con.close()

    r = client.get(f"/api/page/{quote('Ctrl\tTitle', safe='/')}")

    assert r.status_code == 200
    assert r.json()["page"]["title"] == "Ctrl Title"
    assert [b["text"] for b in r.json()["blocks"]] == ["page body"]


def test_get_page_preserves_inactive_padded_exact_reads(client, seeded_config):
    padded = " Legacy Padded Page "
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, padded, 100, 100),
    )
    con.commit()
    con.close()

    exact = client.get(f"/api/page/{quote(padded, safe='/')}")
    stripped = client.get(f"/api/page/{quote(padded.strip(), safe='/')}")

    assert exact.status_code == 200
    assert exact.json()["page"]["title"] == padded
    assert stripped.status_code == 404


def test_get_page_canonicalizes_padded_title_when_plain_space_migration_is_active(
        client, seeded_config):
    canonical = "Legacy Padded Page"
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, canonical, 100, 100),
    )
    con.execute(
        "UPDATE sync_meta SET value = '1'"
        " WHERE key = 'plain_space_title_canonicalization'"
    )
    con.commit()
    con.close()

    r = client.get(f"/api/page/{quote(f' {canonical} ', safe='/')}")

    assert r.status_code == 200
    assert r.json()["page"]["title"] == canonical


def test_create_page_creates_new_page(client):
    r = client.post("/api/pages", json={"title": "New Page"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "New Page"
    assert isinstance(body["id"], int)
    # persisted, not just returned for this request
    assert client.get("/api/page/New Page").status_code == 200


def test_create_page_is_idempotent(client):
    r = client.post("/api/pages", json={"title": "Machine Learning"})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == 1  # existing seeded page, not a duplicate
    assert body["title"] == "Machine Learning"
    assert body["created_at"] == 1000


def test_create_page_rejects_blank_title(client):
    assert client.post("/api/pages", json={"title": ""}).status_code == 422


def test_create_page_rejects_whitespace_only_title(client):
    assert client.post("/api/pages", json={"title": "   "}).status_code == 422


def test_create_page_requires_auth(anon_client):
    r = anon_client.post("/api/pages", json={"title": "New Page"})
    assert r.status_code == 401


def test_delete_page_removes_page_and_blocks(client):
    assert client.get("/api/page/Machine Learning").status_code == 200
    r = client.delete("/api/page/Machine Learning")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert client.get("/api/page/Machine Learning").status_code == 404


def test_delete_page_removes_page_and_blocks_from_search(client):
    # Pre-delete: FTS finds the page title and its block text.
    before = client.get("/api/search?q=Papers").json()
    assert any(b["uid"] == "uid_b2" for b in before["blocks"])

    client.delete("/api/page/Machine Learning")

    after_pages = client.get("/api/search?q=Machine").json()
    assert not any(p["title"] == "Machine Learning" for p in after_pages["pages"])
    after_blocks = client.get("/api/search?q=Papers").json()
    assert not any(b["uid"] == "uid_b2" for b in after_blocks["blocks"])
    # Plain-text mention of "Machine Learning" on an unrelated page (uid_b6,
    # page "AI") is untouched -- only the deleted page's own rows are gone.
    still_there = client.get("/api/search?q=overview").json()
    assert any(b["uid"] == "uid_b6" for b in still_there["blocks"])


def test_delete_page_turns_inbound_links_into_plain_text(
        client, seeded_config):
    # uid_b4 (page "July 7th, 2026") links to "Machine Learning" (page id 1).
    r = client.get("/api/page/July 7th, 2026")
    texts_before = [b["text"] for b in r.json()["blocks"]]
    assert "Studying [[Machine Learning]] today" in texts_before

    assert client.delete("/api/page/Machine Learning").status_code == 200

    r = client.get("/api/page/July 7th, 2026")
    texts_after = [b["text"] for b in r.json()["blocks"]]
    assert "Studying Machine Learning today" in texts_after
    assert "Studying [[Machine Learning]] today" not in texts_after

    con = sqlite3.connect(seeded_config.db_path)
    remaining = read(con,
        "SELECT * FROM refs WHERE target_page_id = 1").fetchall()
    con.close()
    assert remaining == []


def test_delete_preview_counts(client):
    r = client.get("/api/delete-preview", params={"title": "Machine Learning"})
    assert r.status_code == 200
    assert r.json() == {"links": 1, "link_pages": 1, "block_refs": 1,
                        "block_ref_pages": 1, "blockers": []}
    # a preview writes nothing
    assert client.get("/api/page/Machine Learning").status_code == 200


def test_delete_preview_missing_page_404(client):
    r = client.get("/api/delete-preview", params={"title": "No Such Page"})
    assert r.status_code == 404


def test_delete_preview_requires_auth(anon_client):
    r = anon_client.get("/api/delete-preview", params={"title": "AI"})
    assert r.status_code == 401


def _add_query_block(client):
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "batch_q0000001",
        "ops": [{"op": "update_text", "uid": "uid_b4",
                 "text": "{{query: {and: [[Machine Learning]] [[Paper]]}}}",
                 "base_text_hash": text_hash("Studying [[Machine Learning]] today")}]})
    assert r.status_code == 200, r.text


def test_delete_refused_with_blockers_409(client):
    _add_query_block(client)
    r = client.get("/api/delete-preview", params={"title": "Machine Learning"})
    assert [b["uid"] for b in r.json()["blockers"]] == ["uid_b4"]

    r = client.delete("/api/page/Machine Learning")
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["message"] == (
        "page is still referenced in ways a delete cannot rewrite")
    assert detail["blockers"] == [{
        "uid": "uid_b4", "page_title": "July 7th, 2026",
        "text": "{{query: {and: [[Machine Learning]] [[Paper]]}}}",
        "reason": "query"}]
    assert client.get("/api/page/Machine Learning").status_code == 200


B4_SEED = "Studying [[Machine Learning]] today"


def _set_b4(client, text):
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "batch_b4000001",
        "ops": [{"op": "update_text", "uid": "uid_b4", "text": text,
                 "base_text_hash": text_hash(B4_SEED)}]})
    assert r.status_code == 200, r.text


def _b4_text(client):
    page = client.get("/api/page/July 7th, 2026").json()
    return next(b["text"] for b in page["blocks"] if b["uid"] == "uid_b4")


def _rewrite_rows(seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    try:
        return read(con, "SELECT count(*) FROM block_rewrites").fetchone()[0]
    finally:
        con.close()


@pytest.mark.parametrize("text,would_create", [
    # unlinking would turn the block into a new `Machine Learning stuff::`
    ("[[Machine Learning]] stuff:: v", "Machine Learning stuff"),
    # unlinking would make the leading attribute name the page itself
    ("[[Machine Learning]]:: v", None),
])
def test_delete_refused_when_unlinking_changes_the_leading_attribute(
        client, seeded_config, text, would_create):
    _set_b4(client, text)
    r = client.delete("/api/page/Machine Learning")
    assert r.status_code == 409
    assert [(b["uid"], b["reason"]) for b in r.json()["detail"]["blockers"]] \
        == [("uid_b4", "attribute")]
    assert client.get("/api/page/Machine Learning").status_code == 200
    if would_create is not None:
        assert client.get(f"/api/page/{would_create}").status_code == 404
    assert _b4_text(client) == text
    assert _rewrite_rows(seeded_config) == 0


def test_delete_refused_when_the_page_is_used_as_an_attribute(
        client, seeded_config):
    text = "Machine Learning:: supervised"
    _set_b4(client, text)
    preview = client.get(
        "/api/delete-preview", params={"title": "Machine Learning"}).json()
    assert [(b["uid"], b["reason"]) for b in preview["blockers"]] \
        == [("uid_b4", "used_as_attribute")]
    r = client.delete("/api/page/Machine Learning")
    assert r.status_code == 409
    assert [(b["uid"], b["reason"]) for b in r.json()["detail"]["blockers"]] \
        == [("uid_b4", "used_as_attribute")]
    assert client.get("/api/page/Machine Learning").status_code == 200
    assert _b4_text(client) == text
    assert _rewrite_rows(seeded_config) == 0


def test_delete_inlines_an_embed_of_a_page_block(client):
    _set_b4(client, "x {{embed: ((uid_b3))}} y")
    assert client.delete("/api/page/Machine Learning").status_code == 200
    assert _b4_text(client) == (
        "x [[Attention Is All You Need]] is a [[Paper]] y")
    assert client.get("/api/page/Machine Learning").status_code == 404


def test_delete_rolls_back_every_rewrite_when_a_later_one_fails(
        client, seeded_config, monkeypatch):
    from pkm.server import store

    real = store.reindex_refs_for_text
    calls = []

    def failing_second(db, uid, text, now_ms):
        calls.append(uid)
        if len(calls) == 2:
            raise RuntimeError("disk on fire")
        return real(db, uid, text, now_ms)

    monkeypatch.setattr(store, "reindex_refs_for_text", failing_second)
    with pytest.raises(RuntimeError, match="disk on fire"):
        client.delete("/api/page/Machine Learning")
    monkeypatch.setattr(store, "reindex_refs_for_text", real)

    assert calls == ["uid_b4", "uid_b5"]
    page = client.get("/api/page/July 7th, 2026").json()
    assert {b["uid"]: b["text"] for b in page["blocks"]} == {
        "uid_b4": B4_SEED, "uid_b5": "See ((uid_b3)) for details"}
    assert client.get("/api/page/Machine Learning").status_code == 200
    assert _rewrite_rows(seeded_config) == 0


def test_delete_holds_the_write_lock_from_its_snapshot_on(
        client, seeded_config, monkeypatch):
    """A batch committing between the delete's snapshot of referencing
    blocks and its rewrite would escape the unlink. The route must hold the
    write lock across the snapshot."""
    from pkm.server import store

    real_plan = store.plan_delete
    outcome = {}

    def racing(db, page_id, title):
        plan = real_plan(db, page_id, title)
        con2 = sqlite3.connect(seeded_config.db_path)
        con2.execute("PRAGMA busy_timeout=50")
        try:
            con2.execute("UPDATE blocks SET text = '[[Machine Learning]] late'"
                         " WHERE uid = 'uid_b6'")
            con2.commit()
            outcome["locked"] = False
        except sqlite3.OperationalError as exc:
            outcome["locked"] = "locked" in str(exc)
        finally:
            con2.close()
        return plan

    monkeypatch.setattr(store, "plan_delete", racing)
    assert client.delete("/api/page/Machine Learning").status_code == 200
    assert outcome == {"locked": True}


def test_delete_page_busy_returns_503(client, seeded_config):
    con2 = sqlite3.connect(seeded_config.db_path, isolation_level=None)
    con2.execute("BEGIN IMMEDIATE")
    try:
        r = client.delete("/api/page/Machine Learning")
    finally:
        con2.execute("ROLLBACK")
        con2.close()
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "1"
    assert client.get("/api/page/Machine Learning").status_code == 200


def test_delete_page_removes_sidebar_entry(client):
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    assert add.status_code == 200
    entry_id = add.json()["id"]

    client.delete("/api/page/Machine Learning")

    entries = client.get("/api/sidebar").json()["entries"]
    assert not any(e["id"] == entry_id for e in entries)


def test_delete_page_with_padded_path_title_when_plain_space_migration_is_active(
        client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "UPDATE sync_meta SET value = '1'"
        " WHERE key = 'plain_space_title_canonicalization'"
    )
    con.commit()
    con.close()
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    assert add.status_code == 200
    entry_id = add.json()["id"]

    r = client.delete(f"/api/page/{quote(' Machine Learning ', safe='/')}")

    assert r.status_code == 200
    assert client.get("/api/page/Machine Learning").status_code == 404
    entries = client.get("/api/sidebar").json()["entries"]
    assert not any(e["id"] == entry_id for e in entries)


def test_delete_page_with_control_whitespace_path_title(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, "Ctrl Title", 100, 100),
    )
    con.commit()
    con.close()

    r = client.delete(f"/api/page/{quote('Ctrl\tTitle', safe='/')}")

    assert r.status_code == 200
    assert client.get("/api/page/Ctrl Title").status_code == 404


def test_delete_missing_page_404(client):
    assert client.delete("/api/page/No Such Page").status_code == 404


def test_delete_page_requires_auth(anon_client):
    r = anon_client.delete("/api/page/Machine Learning")
    assert r.status_code == 401
