"""A block tombstone ships only in the window that holds the block's delete
row. A replica cascades a block tombstone through its local subtree, after
the upserts of the window that reaches the journal head; a window short of
the head records its block tombstones for that window to apply.

Waiting for the head covers a kept block whose ancestor moved out of the
deleted subtree and was deleted itself in a later window: the ancestor's
move row hydrates to nothing, so a cascade run in the earlier window would
take the replica's stale subtree, and the kept block's child, whose row
never changed, would not ship again."""
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
    replica does: upserts, and block tombstones recorded until the window
    that reaches the journal head, which cascades every recorded one through
    the local subtree after its upserts. A block a later window ships live
    leaves the record. Returns the windows' tombstones and shipped uids, in
    order."""
    windows = []
    owed: list[str] = []
    while True:
        feed = _drain(client, since=since, limit=limit)
        shipped = [b["uid"] for b in feed["blocks"]]
        for b in feed["blocks"]:
            local[b["uid"]] = b["parent_uid"]
        tombs = [t["entity_id"] for t in feed["tombstones"]
                 if t["kind"] == "block"]
        owed = list(dict.fromkeys(
            [u for u in owed if u not in shipped] + tombs))
        windows.append((tombs, shipped))
        if feed["next_since"] >= feed["latest_seq"]:
            for uid in owed:
                doomed = {uid}
                grew = True
                while grew:
                    more = {u for u, p in local.items() if p in doomed} - doomed
                    doomed |= more
                    grew = bool(more)
                for u in doomed:
                    local.pop(u, None)
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


def test_window_cut_before_the_delete_row_ships_the_move_first(client):
    """The feed ships a moved-out block's row no later than its old
    parent's tombstone. The replica's end shape holds either way, since its
    cascade waits for the head window."""
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


@pytest.mark.parametrize("limit", [1, 2])
def test_small_windows_keep_a_descendant_of_an_ancestor_moved_out_then_deleted(
        client, limit):
    start = _build_move_delete_move_delete(client)
    local = _dd_local()
    _catch_up(client, start, local, limit=limit)
    assert _dd_tree(local) == {"uid_dd_k": None, "uid_dd_l": "uid_dd_k"}
