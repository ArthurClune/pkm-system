"""A block tombstone ships only in the window that holds the block's delete
row. A replica cascades a block tombstone through its local subtree, after
the window's upserts. Every block the server kept left that subtree before
the delete, so its move row lies in the delete row's window or an earlier
one. A tombstone shipped from an older live row of the block, ahead of its
delete row, would run the cascade before those moves arrive.

That holds for a kept block whose move out ships no later than the
tombstone. It does not yet hold across windows when the block that moved
out is itself deleted later: its move row hydrates to nothing, so the
cascade runs over the replica's stale subtree (the strict xfail below)."""
import pytest


def _drain(client, since=0, limit=1000):
    r = client.get(f"/api/sync/changes?since={since}&limit={limit}")
    assert r.status_code == 200
    return r.json()


def _ops(client, batch_id, ops):
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": batch_id,
                                      "ops": ops})
    assert r.status_code == 200, r.text
    assert r.json().get("skipped", []) == []


def _catch_up(client, since, local, limit):
    """Apply every window after `since` to `local` (uid -> parent_uid) as the
    replica does: upserts, then block tombstones cascading the local
    subtree. Returns the windows' tombstones and shipped uids, in order."""
    windows = []
    while True:
        feed = _drain(client, since=since, limit=limit)
        for b in feed["blocks"]:
            local[b["uid"]] = b["parent_uid"]
        tombs = [t["entity_id"] for t in feed["tombstones"]
                 if t["kind"] == "block"]
        for uid in tombs:
            doomed = {uid}
            grew = True
            while grew:
                more = {u for u, p in local.items() if p in doomed} - doomed
                doomed |= more
                grew = bool(more)
            for u in doomed:
                local.pop(u, None)
        windows.append((tombs, [b["uid"] for b in feed["blocks"]]))
        if feed["next_since"] >= feed["latest_seq"]:
            return windows
        since = feed["next_since"]


def _build_edit_move_delete(client):
    """P > C > G on AI; then P edited, C moved to the top level, P deleted.
    Returns the seq before the edit."""
    _ops(client, "twbatch-build", [
        {"op": "create", "uid": "uid_tw_p", "page_title": "AI", "parent_uid": None,
         "order_idx": 0, "text": "parent"},
        {"op": "create", "uid": "uid_tw_c", "page_title": "AI",
         "parent_uid": "uid_tw_p", "order_idx": 0, "text": "child"},
        {"op": "create", "uid": "uid_tw_g", "page_title": "AI",
         "parent_uid": "uid_tw_c", "order_idx": 0, "text": "grandchild"},
    ])
    start = _drain(client)["latest_seq"]
    _ops(client, "twbatch-edit", [{"op": "update_text", "uid": "uid_tw_p",
                              "text": "parent, edited"}])
    _ops(client, "twbatch-move", [{"op": "move", "uid": "uid_tw_c", "parent_uid": None,
                              "order_idx": 0, "page_title": "AI"}])
    _ops(client, "twbatch-delete", [{"op": "delete", "uid": "uid_tw_p"}])
    return start


def test_window_cut_before_the_delete_row_keeps_the_moved_out_subtree(client):
    start = _build_edit_move_delete(client)
    local = {"uid_tw_p": None, "uid_tw_c": "uid_tw_p", "uid_tw_g": "uid_tw_c"}

    windows = _catch_up(client, start, local, limit=1)

    first_tomb = next(i for i, (tombs, _) in enumerate(windows)
                      if "uid_tw_p" in tombs)
    first_move = next(i for i, (_, uids) in enumerate(windows)
                      if "uid_tw_c" in uids)
    assert first_move <= first_tomb
    assert "uid_tw_p" not in local
    assert local["uid_tw_c"] is None
    assert local["uid_tw_g"] == "uid_tw_c"


def test_the_delete_row_window_ships_the_tombstone(client):
    start = _build_edit_move_delete(client)
    windows = _catch_up(client, start, {}, limit=1)
    assert sum("uid_tw_p" in tombs for tombs, _ in windows) == 1


def test_one_window_still_ships_the_tombstone(client):
    start = _build_edit_move_delete(client)
    feed = _drain(client, since=start)
    assert {"kind": "block", "entity_id": "uid_tw_p"} in feed["tombstones"]
    assert "uid_tw_p" not in {b["uid"] for b in feed["blocks"]}


def _build_move_delete_move_delete(client):
    """D > A > K > L on AI; then A moved to the top level, D deleted, K
    moved to the top level, A deleted. The server ends with K > L. Returns
    the seq before the first move."""
    _ops(client, "ddbatch-build", [
        {"op": "create", "uid": "uid_dd_d", "page_title": "AI",
         "parent_uid": None, "order_idx": 0, "text": "D"},
        {"op": "create", "uid": "uid_dd_a", "page_title": "AI",
         "parent_uid": "uid_dd_d", "order_idx": 0, "text": "A"},
        {"op": "create", "uid": "uid_dd_k", "page_title": "AI",
         "parent_uid": "uid_dd_a", "order_idx": 0, "text": "K"},
        {"op": "create", "uid": "uid_dd_l", "page_title": "AI",
         "parent_uid": "uid_dd_k", "order_idx": 0, "text": "L"},
    ])
    start = _drain(client)["latest_seq"]
    _ops(client, "ddbatch-move-a", [{"op": "move", "uid": "uid_dd_a",
                                     "parent_uid": None, "order_idx": 0,
                                     "page_title": "AI"}])
    _ops(client, "ddbatch-delete-d", [{"op": "delete", "uid": "uid_dd_d"}])
    _ops(client, "ddbatch-move-k", [{"op": "move", "uid": "uid_dd_k",
                                     "parent_uid": None, "order_idx": 0,
                                     "page_title": "AI"}])
    _ops(client, "ddbatch-delete-a", [{"op": "delete", "uid": "uid_dd_a"}])
    return start


def _dd_local():
    return {"uid_dd_d": None, "uid_dd_a": "uid_dd_d",
            "uid_dd_k": "uid_dd_a", "uid_dd_l": "uid_dd_k"}


def _dd_tree(local):
    return {u: p for u, p in local.items() if u.startswith("uid_dd_")}


def test_one_window_keeps_a_descendant_of_an_ancestor_moved_out_then_deleted(
        client):
    start = _build_move_delete_move_delete(client)
    local = _dd_local()
    _catch_up(client, start, local, limit=1000)
    assert _dd_tree(local) == {"uid_dd_k": None, "uid_dd_l": "uid_dd_k"}


@pytest.mark.xfail(strict=True, reason=(
    "known hole: across windows, an ancestor that moved out of a deleted "
    "subtree and was deleted later ships nothing for its move (it is absent "
    "now and its delete row lies in a later window), so the deleted block's "
    "tombstone cascades the replica's stale subtree; the kept descendant "
    "returns with its own move row, but its child's row never changed and "
    "never re-ships"))
@pytest.mark.parametrize("limit", [1, 2])
def test_small_windows_keep_a_descendant_of_an_ancestor_moved_out_then_deleted(
        client, limit):
    start = _build_move_delete_move_delete(client)
    local = _dd_local()
    _catch_up(client, start, local, limit=limit)
    assert _dd_tree(local) == {"uid_dd_k": None, "uid_dd_l": "uid_dd_k"}
