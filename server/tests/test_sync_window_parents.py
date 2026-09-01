"""Window-split parent-block dependency (pkm-qvlx).

The feed hydrates blocks at CURRENT state inside one read transaction, so a
window whose journal rows predate a parent-child move can ship a block whose
`parent_uid` points at a block none of this window's rows created. Dependency
pages already ship with their referencing blocks; parent blocks must too,
or a replica catching up in windows (degraded network, >limit rows behind)
inserts a dangling parent_uid and its window COMMIT fails the deferred FK
check -- permanently, because the cursor never advances past that window.
"""


def _drain(client, since=0, limit=1000):
    r = client.get(f"/api/sync/changes?since={since}&limit={limit}")
    assert r.status_code == 200
    return r.json()


def test_window_split_ships_dependency_parent_block(client):
    start = _drain(client)["latest_seq"]
    # journal row 1: an old edit to uid_b6 (its row lands in the first window)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "winparent1",
        "ops": [{"op": "update_text", "uid": "uid_b6", "text": "edited early"}]})
    assert r.status_code == 200
    # later journal rows: create a brand-new parent and move uid_b6 under it
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "winparent2",
        "ops": [
            {"op": "create", "uid": "uid_new_parent", "page_title": "AI",
             "parent_uid": None, "order_idx": 1, "text": "new parent"},
            {"op": "move", "uid": "uid_b6", "parent_uid": "uid_new_parent",
             "order_idx": 0},
        ]})
    assert r.status_code == 200

    # walk the feed one journal row at a time, applying like a replica: every
    # parent_uid a window ships must be satisfiable from blocks already seen
    # (local state) or blocks in the same window -- never a later window.
    seen_uids = {"uid_b1", "uid_b2", "uid_b3", "uid_b4", "uid_b5", "uid_b6"}
    since = start
    while True:
        feed = _drain(client, since=since, limit=1)
        window_uids = {b["uid"] for b in feed["blocks"]}
        for b in feed["blocks"]:
            parent = b["parent_uid"]
            if parent is not None:
                assert parent in seen_uids | window_uids, (
                    f"window shipped {b['uid']} with parent {parent} "
                    "that no earlier or same window delivered")
        seen_uids |= window_uids
        for tomb in feed["tombstones"]:
            if tomb["kind"] == "block":
                seen_uids.discard(tomb["entity_id"])
        if feed["next_since"] >= feed["latest_seq"]:
            break
        since = feed["next_since"]


def test_window_split_ships_dependency_own_page(client):
    # a block moved to a brand-new page has the same hazard as a moved
    # parent: the window carrying its stale row can hydrate it at CURRENT
    # state (already on the new page) before the new page's own row ships.
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "winownpage1",
        "ops": [{"op": "update_text", "uid": "uid_b1", "text": "edited early"}]})
    assert r.status_code == 200
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "winownpage2",
        "ops": [{"op": "move", "uid": "uid_b1", "parent_uid": None,
                 "order_idx": 0, "page_title": "Brand New Page"}]})
    assert r.status_code == 200

    # walk the feed one journal row at a time; every block's page_id must be
    # satisfiable from pages already seen (local state) or pages shipped in
    # the same window -- never a later window.
    seen_pages = {1, 2, 3, 4, 5}  # seed pages, already local before the test
    since = start
    while True:
        feed = _drain(client, since=since, limit=1)
        window_pages = {p["id"] for p in feed["pages"]}
        for b in feed["blocks"]:
            assert b["page_id"] in seen_pages | window_pages, (
                f"window shipped {b['uid']} on page {b['page_id']} that no "
                "earlier or same window delivered")
        seen_pages |= window_pages
        for tomb in feed["tombstones"]:
            if tomb["kind"] == "page":
                seen_pages.discard(int(tomb["entity_id"]))
        if feed["next_since"] >= feed["latest_seq"]:
            break
        since = feed["next_since"]


def test_window_split_ships_transitive_grandparent_chain(client):
    # create A, create B under A, then move an existing block under B: the
    # window carrying the moved block's stale row must ship both ancestors,
    # not just the immediate parent (pkm-qvlx transitivity).
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "wingrand1",
        "ops": [{"op": "update_text", "uid": "uid_b6", "text": "edited early too"}]})
    assert r.status_code == 200
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "wingrand2",
        "ops": [
            {"op": "create", "uid": "uid_gpa", "page_title": "AI",
             "parent_uid": None, "order_idx": 2, "text": "grandparent A"},
            {"op": "create", "uid": "uid_b_child", "page_title": "AI",
             "parent_uid": "uid_gpa", "order_idx": 0, "text": "parent B"},
            {"op": "move", "uid": "uid_b6", "parent_uid": "uid_b_child",
             "order_idx": 0},
        ]})
    assert r.status_code == 200

    # the first window only scans uid_b6's stale journal row, but its
    # current-state parent chain (uid_b_child -> uid_gpa) must ship alongside.
    feed = _drain(client, since=start, limit=1)
    window_uids = {b["uid"] for b in feed["blocks"]}
    assert window_uids == {"uid_b6", "uid_b_child", "uid_gpa"}, (
        "window carrying uid_b6's stale row must ship its full transitive "
        f"parent closure, got {window_uids}")
    by_uid = {b["uid"]: b for b in feed["blocks"]}
    assert by_uid["uid_b6"]["parent_uid"] == "uid_b_child"
    assert by_uid["uid_b_child"]["parent_uid"] == "uid_gpa"
    assert by_uid["uid_gpa"]["parent_uid"] is None
