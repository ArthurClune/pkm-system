import sqlite3

from pkm.server.ops_core import text_hash


_batch_counter = 0

def _post(client, *ops, client_id="c1", batch_id=None):
    global _batch_counter
    if batch_id is None:
        _batch_counter += 1
        batch_id = f"batch_{_batch_counter:08d}"
    return client.post("/api/ops",
                       json={"client_id": client_id, "batch_id": batch_id,
                             "ops": list(ops)})


def test_ops_require_auth(anon_client):
    r = anon_client.post("/api/ops", json={
        "client_id": "c1",
        "batch_id": "auth_test1",
        "ops": [{"op": "delete", "uid": "uid_b1"}]})
    assert r.status_code == 401


def test_create_then_read_back(client):
    r = _post(client, {"op": "create", "uid": "newuid1",
                       "page_title": "Machine Learning", "parent_uid": "uid_b2",
                       "order_idx": 1, "text": "fresh [[Novel Page]]"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["applied"] == 1
    page = client.get("/api/page/Machine Learning").json()
    papers = page["blocks"][1]
    assert [c["text"] for c in papers["children"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]", "fresh [[Novel Page]]"]
    # implicit page + backlink
    novel = client.get("/api/page/Novel Page").json()
    [group] = novel["backlinks"]["groups"]
    assert group["page_title"] == "Machine Learning"


def test_update_text_moves_search_and_backlinks(client):
    r = _post(client, {"op": "update_text", "uid": "uid_b4",
                       "text": "now about [[Paper]] instead"})
    assert r.status_code == 200
    hits = client.get("/api/search", params={"q": "Studying"}).json()
    assert hits["blocks"] == []
    paper = client.get("/api/page/Paper").json()
    uids = {i["uid"] for g in paper["backlinks"]["groups"] for i in g["items"]}
    assert "uid_b4" in uids
    ml = client.get("/api/page/Machine Learning").json()
    assert ml["backlinks"]["groups"] == []  # old link gone


def test_move_and_collapse_roundtrip(client):
    r = _post(client,
              {"op": "move", "uid": "uid_b3", "parent_uid": None,
               "order_idx": 0},
              {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True})
    assert r.status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in page["blocks"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]", "Tags:: #AI", "Papers"]
    assert page["blocks"][2]["collapsed"] is True
    assert page["blocks"][2]["children"] == []


def test_set_heading_via_endpoint(client):
    r = _post(client, {"op": "set_heading", "uid": "uid_b2", "heading": 2})
    assert r.status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert page["blocks"][1]["heading"] == 2


def test_set_heading_rejects_out_of_range(client):
    r = _post(client, {"op": "set_heading", "uid": "uid_b2", "heading": 5})
    assert r.status_code == 422


def test_set_view_type_persists_and_roundtrips_in_page_reads(client):
    before = client.get("/api/page/Machine Learning").json()["blocks"][1]
    assert before["view_type"] is None
    r = _post(client, {"op": "set_view_type", "uid": "uid_b2",
                       "view_type": "numbered"})
    assert r.status_code == 200
    after = client.get("/api/page/Machine Learning").json()["blocks"][1]
    assert after["view_type"] == "numbered"
    assert after["text"] == before["text"]
    assert after["collapsed"] == before["collapsed"]
    assert [c["uid"] for c in after["children"]] == \
        [c["uid"] for c in before["children"]]


def test_set_view_type_rejects_unknown_value(client):
    r = _post(client, {"op": "set_view_type", "uid": "uid_b2",
                       "view_type": "table"})
    assert r.status_code == 422


def test_delete_subtree_via_endpoint(client):
    assert _post(client, {"op": "delete", "uid": "uid_b2"}).status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in page["blocks"]] == ["Tags:: #AI"]
    assert client.get("/api/search",
                      params={"q": "Papers"}).json()["blocks"] == []


def test_batch_is_atomic_and_reports_index(client):
    r = _post(client,
              {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
              {"op": "delete", "uid": "ghost99"})
    assert r.status_code == 400
    assert r.json()["detail"]["index"] == 1
    assert "not found" in r.json()["detail"]["reason"]
    page = client.get("/api/page/Machine Learning").json()
    assert page["blocks"][1]["collapsed"] is False  # op 0 rolled back


def test_cycle_move_rejected(client):
    r = _post(client, {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
                       "order_idx": 0})
    assert r.status_code == 400
    assert "cycle" in r.json()["detail"]["reason"]


def test_malformed_batch_422(client):
    r = client.post("/api/ops", json={"client_id": "c1",
                                      "batch_id": "malform1",
                                      "ops": [{"op": "explode"}]})
    assert r.status_code == 422


def test_cross_page_move_under_parent(client, seeded_config):
    # uid_b4 (on "July 7th, 2026") becomes a child of uid_b2 (on "Machine
    # Learning"): subtree page_id follows, uid unchanged.
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "cross_move_1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 99}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == 1 and row["parent_uid"] == "uid_b2"
    con.close()


def test_cross_page_move_top_level_auto_creates_page(client, seeded_config):
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "auto_page1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": None, "order_idx": 0,
         "page_title": "July 1st, 2026"}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    page = con.execute(
        "SELECT id FROM pages WHERE title='July 1st, 2026'").fetchone()
    assert page is not None
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == page["id"] and row["parent_uid"] is None
    con.close()


def test_cross_page_move_subtree_and_backlinks_survive(client, seeded_config):
    # uid_b2 has child uid_b3 ("[[Attention Is All You Need]] is a [[Paper]]").
    # Move uid_b2 to July 7th: child's page_id follows; refs rows untouched;
    # the moved text is still findable via search (FTS keyed by rowid).
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "subtree1",
                                      "ops": [
        {"op": "move", "uid": "uid_b2", "parent_uid": None, "order_idx": 9,
         "page_title": "July 7th, 2026"}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    pages = {r_["uid"]: r_["page_id"] for r_ in con.execute(
        "SELECT uid, page_id FROM blocks WHERE uid IN ('uid_b2','uid_b3')")}
    assert pages == {"uid_b2": 3, "uid_b3": 3}
    refs = con.execute(
        "SELECT count(*) FROM refs WHERE src_block_uid='uid_b3'").fetchone()[0]
    assert refs == 2
    con.close()
    hits = client.get("/api/search", params={"q": "Attention"}).json()
    assert any(b["uid"] == "uid_b3" for b in hits["blocks"])
    assert all(b["page_title"] == "July 7th, 2026"
               for b in hits["blocks"] if b["uid"] == "uid_b3")


def test_batch_rollback_undoes_auto_created_page(client, seeded_config):
    # op 0 moves uid_b4 to a brand-new page (get_or_create_page inserts a
    # pages row mid-batch); op 1 fails. The whole transaction must roll back —
    # the auto-created page and the move both vanish. Exercises the real
    # db.rollback() in routes_ops, not just the pure planner.
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "rollback1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": None, "order_idx": 0,
         "page_title": "Brand New Page"},
        {"op": "delete", "uid": "ghost99"}]})
    assert r.status_code == 400
    assert r.json()["detail"]["index"] == 1
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    assert con.execute(
        "SELECT id FROM pages WHERE title='Brand New Page'").fetchone() is None
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == 3 and row["parent_uid"] is None  # move undone
    con.close()


def test_cross_page_move_page_title_parent_mismatch_400(client):
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "mismatch1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 0, "page_title": "July 7th, 2026"}]})
    assert r.status_code == 400
    assert "page_title does not match" in r.json()["detail"]["reason"]


def test_create_page_op_creates_and_is_idempotent(client):
    body = {"client_id": "c1", "batch_id": "create_page1", "ops": [
        {"op": "create_page", "page_title": "Offline Made Me"}]}
    assert client.post("/api/ops", json=body).status_code == 200
    assert client.post("/api/ops", json=body).status_code == 200  # replayable
    r = client.get("/api/page/Offline%20Made%20Me")
    assert r.status_code == 200
    # exactly one page: titles endpoint returns it once
    titles = client.get("/api/titles?q=Offline%20Made%20Me").json()["titles"]
    assert titles.count("Offline Made Me") == 1


def test_create_page_op_reaches_changes_feed(client):
    start = client.get("/api/sync/changes").json()["latest_seq"]
    client.post("/api/ops", json={"client_id": "c1", "batch_id": "feed_vis1",
                                  "ops": [
        {"op": "create_page", "page_title": "Feed Visible"}]})
    feed = client.get(f"/api/sync/changes?since={start}").json()
    assert "Feed Visible" in {p["title"] for p in feed["pages"]}


def test_conflict_copy_lands_next_to_target(client):
    # uid_b1's live text is "Tags:: #AI" (conftest seed); simulate an
    # offline edit based on stale text
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": "conflict1",
                                      "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "offline edit",
         "base_text_hash": text_hash("some stale base")}]})
    assert r.status_code == 200
    page = client.get("/api/page/Machine%20Learning").json()
    texts = [b["text"] for b in page["blocks"]]
    i = texts.index("offline edit")
    assert texts[i + 1] == "[[conflict]] Tags:: #AI"


def test_no_false_conflict_after_structural_change(client):
    base = "Tags:: #AI"
    # a collapse (structural op) between base and push must NOT conflict
    client.post("/api/ops", json={"client_id": "c1", "batch_id": "struct_chg1",
                                  "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]})
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": "struct_chg2",
                                      "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "clean edit",
         "base_text_hash": text_hash(base)}]})
    assert r.status_code == 200
    page = client.get("/api/page/Machine%20Learning").json()
    assert not any("[[conflict]]" in b["text"] for b in page["blocks"])


def test_orphaned_edit_lands_on_todays_daily_page(client):
    from datetime import date
    from pkm.server.daily import title_for_date
    client.post("/api/ops", json={"client_id": "c1", "batch_id": "orphan_edit1",
                                  "ops": [
        {"op": "delete", "uid": "uid_b6"}]})
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": "orphan_edit2",
                                      "ops": [
        {"op": "update_text", "uid": "uid_b6", "text": "edited after delete",
         "base_text_hash": text_hash("whatever")}]})
    assert r.status_code == 200
    daily = client.get(f"/api/page/{title_for_date(date.today())}").json()
    assert any(
        b["text"] == "[[conflict]] (original block deleted) edited after delete"
        for b in daily["blocks"])


def test_hashless_update_on_missing_block_still_400s(client):
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": "gone_uid1",
                                      "ops": [
        {"op": "update_text", "uid": "gone_uid1", "text": "x"}]})
    assert r.status_code == 400
