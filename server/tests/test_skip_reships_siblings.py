"""A create or move the server skips re-ships its destination sibling
group. The client's optimistic apply shifted those siblings' order_idx;
the server shifted nothing, so only journal rows for them bring the
replica's keys back to the server's."""
import pytest

from pkm.server.db import open_db

PAGE = "Sib Page"
_counter = 0


def _post(client, *ops):
    global _counter
    _counter += 1
    r = client.post("/api/ops", json={"client_id": "c1",
                                      "batch_id": f"sibs_{_counter:06d}",
                                      "ops": list(ops)})
    assert r.status_code == 200, r.text
    return r.json()


def _create(uid, idx, parent=None):
    return {"op": "create", "uid": uid, "page_title": PAGE,
            "parent_uid": parent, "order_idx": idx, "text": f"text {uid}"}


def _seed_top_level(client):
    _post(client, *(_create(f"sib_s{i}", (i - 1) * 10) for i in range(1, 5)))


def _latest_seq(client):
    return client.get("/api/sync/changes?since=0&limit=1").json()["latest_seq"]


def _feed_since(client, seq):
    feed = client.get(f"/api/sync/changes?since={seq}").json()
    return ({b["uid"]: b for b in feed["blocks"]},
            {t["entity_id"] for t in feed["tombstones"] if t["kind"] == "block"})


def _journalled_since(seeded_config, seq):
    con = open_db(seeded_config.db_path)
    try:
        return [(r["entity_id"], r["deleted"]) for r in con.execute(
            "SELECT entity_id, deleted FROM changes WHERE seq > ?"
            " AND kind = 'block' ORDER BY seq", (seq,))]
    finally:
        con.close()


def _block_state(seeded_config):
    """Every column of this test's blocks, plus the derived indexes a touch
    must leave alone. (The skip's own daily-note entry is new, and is not
    one of them.)"""
    con = open_db(seeded_config.db_path)
    try:
        blocks = [tuple(r) for r in con.execute(
            "SELECT * FROM blocks WHERE uid LIKE 'sib\\_%' ESCAPE '\\'"
            " ORDER BY uid")]
        refs = [tuple(r) for r in con.execute(
            "SELECT * FROM refs WHERE src_block_uid LIKE 'sib\\_%' ESCAPE '\\'"
            " ORDER BY 1, 2, 3")]
        block_refs = [tuple(r) for r in con.execute(
            "SELECT * FROM block_refs ORDER BY 1, 2")]
        fts = [tuple(r) for r in con.execute(
            "SELECT rowid, text FROM blocks_fts WHERE blocks_fts MATCH 'text'"
            " ORDER BY rowid")]
        return blocks, refs, block_refs, fts
    finally:
        con.close()


# untitled: the move targets the block's own page, which the server reads
# from the block's delete row in the journal
@pytest.mark.parametrize("page_title", [PAGE, None], ids=["titled", "untitled"])
def test_skipped_move_reships_destination_siblings(client, page_title):
    _seed_top_level(client)
    _post(client, {"op": "delete", "uid": "sib_s2"})
    since = _latest_seq(client)
    move = {"op": "move", "uid": "sib_s2", "parent_uid": None, "order_idx": 0}
    if page_title is not None:
        move["page_title"] = page_title
    ack = _post(client, move)
    assert [s["reason"] for s in ack["skipped"]] == ["block_not_found"]
    blocks, tombstones = _feed_since(client, since)
    assert "sib_s2" in tombstones
    assert {u: blocks[u]["order_idx"] for u in ("sib_s1", "sib_s3", "sib_s4")
            if u in blocks} == {"sib_s1": 0, "sib_s3": 20, "sib_s4": 30}


def test_skipped_move_under_a_live_parent_reships_its_children(client):
    _post(client, _create("sib_pp", 0),
          _create("sib_c1", 0, "sib_pp"), _create("sib_c2", 10, "sib_pp"),
          _create("sib_xx", 10))
    _post(client, {"op": "delete", "uid": "sib_xx"})
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_xx", "parent_uid": "sib_pp",
                         "order_idx": 0})
    assert [s["reason"] for s in ack["skipped"]] == ["block_not_found"]
    blocks, tombstones = _feed_since(client, since)
    assert "sib_xx" in tombstones
    assert blocks["sib_c1"]["order_idx"] == 0
    assert blocks["sib_c2"]["order_idx"] == 10


def test_the_touch_changes_no_column_or_index_and_rides_the_batch(
        client, seeded_config):
    _seed_top_level(client)
    _post(client, {"op": "update_text", "uid": "sib_s3",
                   "text": "text [[Linked]] ((sib_s1))"})
    _post(client, {"op": "delete", "uid": "sib_s2"})
    before = _block_state(seeded_config)
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_s2", "parent_uid": None,
                         "order_idx": 0, "page_title": PAGE})
    assert _block_state(seeded_config) == before
    # written in the batch's own transaction: the ack's seq covers them
    assert ack["seq"] == _latest_seq(client)
    journalled = _journalled_since(seeded_config, since)
    # the tombstone leads; the live siblings trail
    assert journalled[0] == ("sib_s2", 1)
    assert {("sib_s1", 0), ("sib_s3", 0), ("sib_s4", 0)} <= set(journalled)


def test_cycle_skip_reships_the_targets_children(client):
    # sib_aa > sib_bb > (sib_c1, sib_c2); moving sib_aa under sib_bb is a cycle.
    # The replica's optimistic apply shifted sib_bb's children.
    _post(client, _create("sib_aa", 0), _create("sib_bb", 0, "sib_aa"),
          _create("sib_c1", 0, "sib_bb"), _create("sib_c2", 10, "sib_bb"))
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_aa", "parent_uid": "sib_bb",
                         "order_idx": 0})
    assert [s["reason"] for s in ack["skipped"]] == ["cycle"]
    blocks, _ = _feed_since(client, since)
    assert blocks["sib_c1"]["order_idx"] == 0
    assert blocks["sib_c2"]["order_idx"] == 10


@pytest.mark.parametrize("op", [
    {"op": "move", "uid": "sib_s1", "parent_uid": "sib_gone",
     "order_idx": 0},
    {"op": "create", "uid": "sib_new", "page_title": PAGE,
     "parent_uid": "sib_gone", "order_idx": 0, "text": "lost"},
], ids=["move", "create"])
def test_missing_parent_skip_reships_nothing_beyond_its_journal(
        client, seeded_config, op):
    # The parent's group is gone with it: its tombstone cascades the
    # replica's shifted copies, and a child another device moved out first
    # ships with that move. No stray sibling rows.
    _seed_top_level(client)
    _post(client, _create("sib_gone", 40), _create("sib_k1", 0, "sib_gone"))
    _post(client, {"op": "delete", "uid": "sib_gone"})
    since = _latest_seq(client)
    ack = _post(client, op)
    assert [s["reason"] for s in ack["skipped"]] == ["parent_not_found"]
    journalled = {u for u, _ in _journalled_since(seeded_config, since)}
    page_blocks = {"sib_s1", "sib_s2", "sib_s3", "sib_s4"}
    if op["op"] == "move":
        # the moved block's own subtree, as before
        assert journalled & page_blocks == {"sib_s1"}
    else:
        assert journalled & page_blocks == set()
    assert "sib_gone" in journalled


def test_blank_title_reships_the_untitled_pages_top_level(client):
    # an applied top-level move with a blank page_title lands on "Untitled",
    # on both sides, so that is the group a skipped one shifted
    _post(client, {"op": "create", "uid": "sib_u1", "page_title": "Untitled",
                   "parent_uid": None, "order_idx": 0, "text": "t"},
          {"op": "create", "uid": "sib_gone2", "page_title": "Untitled",
           "parent_uid": None, "order_idx": 10, "text": "t"})
    _post(client, {"op": "delete", "uid": "sib_gone2"})
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_gone2", "parent_uid": None,
                         "order_idx": 0, "page_title": "   "})
    assert [s["reason"] for s in ack["skipped"]] == ["block_not_found"]
    blocks, _ = _feed_since(client, since)
    assert blocks["sib_u1"]["order_idx"] == 0


def test_title_naming_no_page_reships_nothing_and_creates_no_page(
        client, seeded_config):
    _seed_top_level(client)
    _post(client, {"op": "delete", "uid": "sib_s2"})
    since = _latest_seq(client)
    _post(client, {"op": "move", "uid": "sib_s2", "parent_uid": None,
                   "order_idx": 0, "page_title": "Not A Page Yet"})
    journalled = {u for u, _ in _journalled_since(seeded_config, since)}
    assert journalled & {"sib_s1", "sib_s3", "sib_s4"} == set()
    con = open_db(seeded_config.db_path)
    try:
        assert con.execute("SELECT 1 FROM pages WHERE title = ?",
                           ("Not A Page Yet",)).fetchone() is None
    finally:
        con.close()


def test_a_skips_own_tombstone_does_not_hide_the_blocks_page(client):
    # the skip journals the gone uid again as a tombstone with no page; a
    # later skip of the same uid must still find the page its delete wrote
    _seed_top_level(client)
    _post(client, {"op": "delete", "uid": "sib_s2"})
    move = {"op": "move", "uid": "sib_s2", "parent_uid": None, "order_idx": 0}
    _post(client, move)
    since = _latest_seq(client)
    _post(client, move)
    blocks, _ = _feed_since(client, since)
    assert {"sib_s1", "sib_s3", "sib_s4"} <= set(blocks)


def test_untitled_skip_of_a_uid_never_deleted_reships_nothing(
        client, seeded_config):
    _seed_top_level(client)
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_never1", "parent_uid": None,
                         "order_idx": 0})
    assert [s["reason"] for s in ack["skipped"]] == ["block_not_found"]
    journalled = {u for u, _ in _journalled_since(seeded_config, since)}
    assert journalled & {"sib_s1", "sib_s2", "sib_s3", "sib_s4"} == set()


def test_orphan_move_under_a_gone_parent_reships_nothing(client, seeded_config):
    _seed_top_level(client)
    _post(client, _create("sib_gone3", 40), _create("sib_k3", 0, "sib_gone3"))
    _post(client, {"op": "delete", "uid": "sib_gone3"})
    _post(client, {"op": "delete", "uid": "sib_s2"})
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_s2",
                         "parent_uid": "sib_gone3", "order_idx": 0})
    assert [s["reason"] for s in ack["skipped"]] == ["block_not_found"]
    journalled = {u for u, _ in _journalled_since(seeded_config, since)}
    assert journalled & {"sib_s1", "sib_s3", "sib_s4", "sib_k3"} == set()


def _page_id(seeded_config, title):
    con = open_db(seeded_config.db_path)
    try:
        return con.execute("SELECT id FROM pages WHERE title = ?",
                           (title,)).fetchone()["id"]
    finally:
        con.close()


def _tombstone_pages(seeded_config, uid):
    con = open_db(seeded_config.db_path)
    try:
        return [r["page_id"] for r in con.execute(
            "SELECT page_id FROM changes WHERE entity_id = ? AND deleted = 1"
            " ORDER BY seq", (uid,))]
    finally:
        con.close()


@pytest.mark.parametrize("text", ["typed under a gone parent", ""],
                         ids=["landed", "blank"])
def test_skipped_move_of_a_diverted_create_reships_siblings(
        client, seeded_config, text):
    # The client created sib_new2 under sib_s1, which another device had
    # deleted, so the server diverted it and sib_new2 never existed there.
    # The client then moved it to the top level of the page it placed it
    # on, shifting that page's top level.
    _seed_top_level(client)
    _post(client, {"op": "delete", "uid": "sib_s1"})
    _post(client, {"op": "create", "uid": "sib_new2", "page_title": PAGE,
                   "parent_uid": "sib_s1", "order_idx": 0, "text": text})
    assert _tombstone_pages(seeded_config, "sib_new2") == [
        _page_id(seeded_config, PAGE)]
    since = _latest_seq(client)
    ack = _post(client, {"op": "move", "uid": "sib_new2", "parent_uid": None,
                         "order_idx": 0})
    assert [s["reason"] for s in ack["skipped"]] == ["block_not_found"]
    blocks, _ = _feed_since(client, since)
    assert {u: blocks[u]["order_idx"] for u in ("sib_s2", "sib_s3", "sib_s4")
            if u in blocks} == {"sib_s2": 10, "sib_s3": 20, "sib_s4": 30}


def test_diverted_create_with_a_stale_title_takes_its_parents_page(
        client, seeded_config):
    # page_title no longer names a page (renamed on another device): the
    # client placed the block on its parent's page, which the parent's own
    # delete row recorded
    _seed_top_level(client)
    _post(client, {"op": "delete", "uid": "sib_s1"})
    _post(client, {"op": "create", "uid": "sib_new3",
                   "page_title": "Title Since Renamed", "parent_uid": "sib_s1",
                   "order_idx": 0, "text": "x"})
    assert _tombstone_pages(seeded_config, "sib_new3") == [
        _page_id(seeded_config, PAGE)]


def test_diverted_create_with_no_known_page_records_none(
        client, seeded_config):
    _post(client, {"op": "create", "uid": "sib_new4",
                   "page_title": "Never A Page", "parent_uid": "sib_never2",
                   "order_idx": 0, "text": "x"})
    assert _tombstone_pages(seeded_config, "sib_new4") == [None]
