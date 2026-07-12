"""Changes feed + snapshot. Hydration must be dependency-complete: a
window shipping a block+refs also ships the referenced pages, and reads
happen inside one transaction."""


def _drain(client, since=0, limit=1000):
    r = client.get(f"/api/sync/changes?since={since}&limit={limit}")
    assert r.status_code == 200
    return r.json()


def test_bootstrap_snapshot_has_everything_and_a_seq(client):
    r = client.get("/api/sync/snapshot")
    assert r.status_code == 200
    snap = r.json()
    assert snap["seq"] > 0
    assert {p["title"] for p in snap["pages"]} >= {"Machine Learning", "AI"}
    blocks = {b["uid"]: b for b in snap["blocks"]}
    assert blocks["uid_b3"]["text"].startswith("[[Attention")
    assert {r_["target_page_id"] for r_ in blocks["uid_b3"]["refs"]} == {4, 5}


def test_feed_returns_full_block_payload_and_advances_cursor(client):
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "now says [[AI]]"}]})
    assert r.status_code == 200
    feed = _drain(client, since=start)
    assert feed["reset"] is False
    uids = {b["uid"] for b in feed["blocks"]}
    assert "uid_b1" in uids
    blk = next(b for b in feed["blocks"] if b["uid"] == "uid_b1")
    assert blk["text"] == "now says [[AI]]"
    assert feed["next_since"] == feed["latest_seq"]  # window covered all rows
    # feed is empty when drained from next_since
    again = _drain(client, since=feed["next_since"])
    assert again["blocks"] == [] and again["tombstones"] == []


def test_window_split_ships_dependency_page_for_refs(client):
    """A block whose text creates an implicit page: even a limit=1 window
    containing only the block's journal row must ship the referenced page
    payload so the client's refs FK target exists."""
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b6",
         "text": "links [[Brand New Page]]"}]})
    assert r.status_code == 200
    # walk the new rows one journal row at a time
    seen_pages, seen_block = set(), False
    since = start
    while True:
        feed = _drain(client, since=since, limit=1)
        if not feed["blocks"] and not feed["pages"] and not feed["tombstones"]:
            break
        for b in feed["blocks"]:
            if b["uid"] == "uid_b6":
                seen_block = True
                # every window carrying this block must carry its dep page
                assert "Brand New Page" in {p["title"] for p in feed["pages"]}
        seen_pages |= {p["title"] for p in feed["pages"]}
        since = feed["next_since"]
    assert seen_block and "Brand New Page" in seen_pages


def test_delete_yields_tombstones_for_whole_subtree(client):
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "delete", "uid": "uid_b2"}]})
    assert r.status_code == 200
    feed = _drain(client, since=start)
    tombs = {(t["kind"], t["entity_id"]) for t in feed["tombstones"]}
    assert ("block", "uid_b2") in tombs and ("block", "uid_b3") in tombs


def test_cursor_ahead_of_journal_requests_reset(client):
    feed = _drain(client, since=10_000_000)
    assert feed["reset"] is True


def test_sync_requires_auth(anon_client):
    assert anon_client.get("/api/sync/changes").status_code in (401, 403)
    assert anon_client.get("/api/sync/snapshot").status_code in (401, 403)
