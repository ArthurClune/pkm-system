"""`/api/ops` refuses a create or text edit whose text is over the block
text length cap or nests `[[` past the nesting cap, naming the block, and
leaves rows already over a limit readable, movable and deletable."""
from __future__ import annotations

import pytest

from pkm.contracts.ops import BlockUid, OrderIdx
from pkm.server import db as db_module
from pkm.server.db import open_db
from pkm.server.store import reindex_refs_for_text
from pkm.test_data.ids import (batch_id_of, client_id_of, order_idx_of,
                               uid_of)

PAGE = "Limits"
BAD_REF_01 = uid_of("bad_ref_01")
CAP_LONG_01 = uid_of("cap_long_01")
CAP_NEST_01 = uid_of("cap_nest_01")
FINE_BLK_01 = uid_of("fine_blk_01")
LEGACY_0001 = uid_of("legacy_0001")
LEGACY_0002 = uid_of("legacy_0002")
MISSING_001 = uid_of("missing_001")
NEST_UPD_01 = uid_of("nest_upd_01")
ORPHAN_0001 = uid_of("orphan_0001")
OVER_LEN_01 = uid_of("over_len_01")
OVER_LEN_02 = uid_of("over_len_02")
_batch_counter = 0


def nest(depth: int) -> str:
    """`depth` runs that are no refs, so the title guard passes them."""
    return "[[a//" * depth + "x" + "]]" * depth


def _post(client, *ops):
    global _batch_counter
    _batch_counter += 1
    return client.post("/api/ops", json={
        "client_id": client_id_of("limits"),
        "batch_id": batch_id_of(f"limits_{_batch_counter:08d}"),
        "ops": list(ops)})


def _create(uid: BlockUid, text: str, parent_uid: BlockUid | None = None,
            order_idx: OrderIdx = order_idx_of(0)) -> dict[str, object]:
    return {"op": "create", "uid": uid, "page_title": PAGE,
            "parent_uid": parent_uid, "order_idx": order_idx, "text": text}


def _page(client) -> None:
    assert client.post("/api/pages", json={"title": PAGE}).status_code < 300


def _block_text(client, uid: BlockUid) -> str | None:
    r = client.get(f"/api/block/{uid}")
    if r.status_code == 404:
        return None
    assert r.status_code == 200, r.text
    return r.json()["block"]["text"]


def _write_legacy_row(config, uid: BlockUid, text: str,
                      order_idx: OrderIdx) -> None:
    """Straight to the table, as a row stored before the limits would be."""
    con = open_db(config.db_path)
    try:
        page = con.select_one(
            "SELECT id AS page_id FROM pages WHERE title = ?", (PAGE,))
        assert page is not None
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES (?,?,NULL,?,?,0)",
            (uid, page["page_id"], order_idx, text))
        reindex_refs_for_text(con, uid, text, 0)
        con.commit()
    finally:
        con.close()


def test_create_at_the_caps_is_stored(client):
    _page(client)
    long_text = "x" * 1_000_000
    r = _post(client, _create(CAP_LONG_01, long_text),
              _create(CAP_NEST_01, nest(32), order_idx=order_idx_of(1)))
    assert r.status_code == 200, r.text[:500]
    assert _block_text(client, CAP_LONG_01) == long_text
    assert _block_text(client, CAP_NEST_01) == nest(32)


def test_create_past_the_length_cap_is_refused_whole(client):
    _page(client)
    r = _post(client, _create(FINE_BLK_01, "fine"),
              _create(OVER_LEN_01, "x" * 1_000_001, order_idx=order_idx_of(1)))
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {
        "index": 1,
        "reason": f"block {OVER_LEN_01}: text of 1000001 characters is over"
                  " the limit of 1000000"}
    assert _block_text(client, FINE_BLK_01) is None
    assert _block_text(client, OVER_LEN_01) is None


def test_update_text_past_the_nesting_limit_is_refused(client):
    _page(client)
    assert _post(client, _create(NEST_UPD_01, "before")).status_code == 200
    r = _post(client, {"op": "update_text", "uid": NEST_UPD_01,
                       "text": nest(33)})
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {
        "index": 0,
        "reason": f"block {NEST_UPD_01}: [[ nested 33 levels deep is over the"
                  " limit of 32"}
    assert _block_text(client, NEST_UPD_01) == "before"


def test_limits_are_judged_before_titles(client):
    _page(client)
    r = _post(client, _create(BAD_REF_01, "[[New #Old]]"),
              _create(OVER_LEN_02, "x" * 1_000_001, order_idx=order_idx_of(1)))
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {
        "index": 1,
        "reason": f"block {OVER_LEN_02}: text of 1000001 characters is over"
                  " the limit of 1000000"}


def test_a_legacy_over_limit_row(client, seeded_config):
    _page(client)
    legacy = "x" * 1_000_005
    _write_legacy_row(seeded_config, LEGACY_0001, legacy, order_idx_of(0))
    _write_legacy_row(seeded_config, LEGACY_0002, legacy, order_idx_of(1))

    r = client.get(f"/api/page/{PAGE}")
    assert r.status_code == 200, r.text[:500]

    assert _post(client, {"op": "move", "uid": LEGACY_0001,
                          "parent_uid": None, "order_idx": 5}
                 ).status_code == 200
    assert _post(client, {"op": "set_heading", "uid": LEGACY_0001,
                          "heading": 2}).status_code == 200

    r = _post(client, {"op": "update_text", "uid": LEGACY_0001,
                       "text": "x" * 1_000_004})
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"]["reason"] == (
        f"block {LEGACY_0001}: text of 1000004 characters is over the limit"
        " of 1000000")
    assert _block_text(client, LEGACY_0001) == legacy

    r = _post(client, {"op": "update_text", "uid": LEGACY_0001,
                       "text": "short"})
    assert r.status_code == 200, r.text[:500]
    assert _block_text(client, LEGACY_0001) == "short"

    r = _post(client, {"op": "delete", "uid": LEGACY_0002})
    assert r.status_code == 200, r.text[:500]
    assert _block_text(client, LEGACY_0002) is None


def test_a_skipped_create_is_still_judged(client):
    _page(client)
    r = _post(client, _create(ORPHAN_0001, "x" * 1_000_001,
                              parent_uid=MISSING_001))
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {
        "index": 0,
        "reason": f"block {ORPHAN_0001}: text of 1000001 characters is over"
                  " the limit of 1000000"}
    assert _block_text(client, ORPHAN_0001) is None


# -- the judges run before the write lock ---------------------------------

@pytest.fixture
def write_lock_held(seeded_config, monkeypatch):
    """Another connection holds the write lock for the test's duration, and
    the busy timeout is short, so a request that waits for it 503s fast."""
    monkeypatch.setattr(db_module, "BUSY_TIMEOUT_MS", 50)
    holder = db_module.open_db(seeded_config.db_path)
    holder.execute("BEGIN IMMEDIATE")
    try:
        yield
    finally:
        holder.commit()
        holder.close()


def test_an_over_limit_batch_is_refused_without_the_write_lock(
        client, write_lock_held):
    r = _post(client, _create(OVER_LEN_01, "x" * 1_000_001))
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {
        "index": 0,
        "reason": f"block {OVER_LEN_01}: text of 1000001 characters is over"
                  " the limit of 1000000"}


def test_a_bad_title_batch_is_refused_without_the_write_lock(
        client, write_lock_held):
    r = _post(client, {"op": "create_page", "page_title": "New #Old"})
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {
        "index": 0,
        "reason": "unsupported page_title title syntax: 'New #Old'"}


def test_a_judged_batch_still_waits_for_the_lock(client, write_lock_held):
    r = _post(client, _create(FINE_BLK_01, "fine"))
    assert r.status_code == 503, r.text[:500]
    assert r.headers["retry-after"] == "1"
