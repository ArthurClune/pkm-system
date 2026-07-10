import sqlite3


def _post(client, *ops, client_id="c1"):
    return client.post("/api/ops",
                       json={"client_id": client_id, "ops": list(ops)})


def test_ops_require_auth(anon_client):
    r = anon_client.post("/api/ops", json={
        "client_id": "c1",
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
                                      "ops": [{"op": "explode"}]})
    assert r.status_code == 422


def test_cross_page_move_under_parent(client, seeded_config):
    # uid_b4 (on "July 7th, 2026") becomes a child of uid_b2 (on "Machine
    # Learning"): subtree page_id follows, uid unchanged.
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
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
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
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
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
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


def test_cross_page_move_page_title_parent_mismatch_400(client):
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 0, "page_title": "July 7th, 2026"}]})
    assert r.status_code == 400
    assert "page_title does not match" in r.json()["detail"]["reason"]
