"""A page or sidebar id deleted and handed to a new row inside one changes
window ships as a tombstone and a live row, so a replica drops what hung
off the old entity before the new one lands."""


def _drain(client, since=0, limit=1000):
    r = client.get(f"/api/sync/changes?since={since}&limit={limit}")
    assert r.status_code == 200
    return r.json()


def _tombstones(feed):
    return {(t["kind"], t["entity_id"]) for t in feed["tombstones"]}


def _reuse_page_id(client) -> tuple[int, int]:
    """Create "Doomed", delete it, create "Reborn"; SQLite gives Reborn the
    freed id because Doomed held the highest one. Returns the journal seq
    before the delete and the reused id."""
    r = client.post("/api/pages", json={"title": "Doomed"})
    assert r.status_code == 200
    doomed = r.json()["id"]
    start = _drain(client)["latest_seq"]
    assert client.delete("/api/page/Doomed").status_code == 200
    r = client.post("/api/pages", json={"title": "Reborn"})
    assert r.status_code == 200
    reborn = r.json()["id"]
    assert reborn == doomed  # precondition: the id really was reused
    return start, reborn


def test_reused_page_id_ships_tombstone_and_new_page(client):
    start, pid = _reuse_page_id(client)
    feed = _drain(client, since=start)
    assert ("page", str(pid)) in _tombstones(feed)
    assert {p["id"]: p["title"] for p in feed["pages"]}[pid] == "Reborn"


def test_window_cut_after_the_delete_row_ships_tombstone_and_live_page(
        client):
    start, pid = _reuse_page_id(client)
    # Doomed had no blocks and no sidebar entry, so the first row after
    # `start` is the page's delete row; Reborn's create row is outside
    feed = _drain(client, since=start, limit=1)
    assert feed["next_since"] < feed["latest_seq"]
    assert ("page", str(pid)) in _tombstones(feed)
    assert {p["id"]: p["title"] for p in feed["pages"]}[pid] == "Reborn"


def test_reused_sidebar_id_ships_tombstone_and_new_entry(client):
    r = client.post("/api/sidebar", json={"title": "SbDoomed"})
    assert r.status_code == 200
    sid = r.json()["id"]
    start = _drain(client)["latest_seq"]
    assert client.delete(f"/api/sidebar/{sid}").status_code == 200
    r = client.post("/api/sidebar", json={"title": "SbReborn"})
    assert r.status_code == 200
    assert r.json()["id"] == sid  # precondition: the id really was reused
    feed = _drain(client, since=start)
    assert ("sidebar", str(sid)) in _tombstones(feed)
    assert {s["id"]: s["title"] for s in feed["sidebar"]}[sid] == "SbReborn"


def test_reused_page_window_ships_blocks_on_and_referencing_the_page(client):
    # The replica applies tombstones first, so the page tombstone's cascade
    # removes every local block on the id and every ref to it. A window
    # that ships the page as tombstone plus live row must therefore ship
    # the current blocks on the page and those referencing it, even when
    # their own journal rows fall in a later window.
    start, pid = _reuse_page_id(client)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "reuse_dependents1", "ops": [
            {"op": "create", "uid": "uid_reborn_kid", "page_title": "Reborn",
             "parent_uid": None, "order_idx": 0, "text": "on the new page"},
            {"op": "update_text", "uid": "uid_b6",
             "text": "links [[Reborn]]"}]})
    assert r.status_code == 200, r.text
    # the page delete row and the page create row only
    feed = _drain(client, since=start, limit=2)
    assert feed["next_since"] < feed["latest_seq"]
    assert ("page", str(pid)) in _tombstones(feed)
    blocks = {b["uid"]: b for b in feed["blocks"]}
    assert {"uid_reborn_kid", "uid_b6"} <= set(blocks)
    assert {"target_page_id": pid, "kind": "link"} in blocks["uid_b6"]["refs"]
    # dependency-complete: every page a shipped block needs ships too
    page_ids = {p["id"] for p in feed["pages"]}
    assert {b["page_id"] for b in feed["blocks"]} <= page_ids
    assert {r_["target_page_id"] for b in feed["blocks"]
            for r_ in b["refs"]} <= page_ids


def test_reused_page_dependents_are_not_shipped_twice(client):
    start, _pid = _reuse_page_id(client)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "reuse_dependents2", "ops": [
            {"op": "create", "uid": "uid_reborn_kid2", "page_title": "Reborn",
             "parent_uid": None, "order_idx": 0, "text": "[[Reborn]] self"}]})
    assert r.status_code == 200, r.text
    # one window holding the block's own row as well as the page rows; the
    # block is on the page and references it
    feed = _drain(client, since=start)
    uids = [b["uid"] for b in feed["blocks"]]
    assert uids.count("uid_reborn_kid2") == 1


def test_window_with_no_reused_page_ships_no_extra_blocks(client):
    # a page deleted and not reused leaves nothing on or pointing at it
    r = client.post("/api/pages", json={"title": "Gone"})
    assert r.status_code == 200
    start = _drain(client)["latest_seq"]
    assert client.delete("/api/page/Gone").status_code == 200
    feed = _drain(client, since=start)
    assert feed["blocks"] == []
    assert _tombstones(feed) == {("page", str(r.json()["id"]))}


def test_deleted_not_reused_page_runs_no_dependents_query(client,
                                                          monkeypatch):
    # only an id that is tombstoned in the window AND live now is reused;
    # a page that is simply gone must not cost the dependents fetch
    from pkm.server import routes_sync

    def _must_not_run(db, page_ids):
        raise AssertionError(f"dependents fetched for {page_ids}")

    monkeypatch.setattr(routes_sync, "_reused_page_dependents", _must_not_run)
    r = client.post("/api/pages", json={"title": "GoneForGood"})
    assert r.status_code == 200
    start = _drain(client)["latest_seq"]
    assert client.delete("/api/page/GoneForGood").status_code == 200
    feed = _drain(client, since=start)
    assert _tombstones(feed) == {("page", str(r.json()["id"]))}
