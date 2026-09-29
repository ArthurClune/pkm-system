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
