"""`/api/ops` refuses a create or text edit whose text is over the block
text length cap or nests `[[` past the nesting cap, naming the block, and
leaves rows already over a limit readable, movable and deletable."""
from __future__ import annotations

from datetime import date

import pytest

from pkm import text_limits
from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING,
                               BlockUid, OrderIdx, text_hash)
from pkm.server import db as db_module
from pkm.server.db import open_db
from pkm.server.store import reindex_refs_for_text
from pkm.server.sync_meta import set_plain_space_title_canonicalization
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


# -- a stored batch replays its ack whatever the judges say now ------------

def test_a_stored_batch_replays_its_ack_after_a_limit_tightens(
        client, monkeypatch):
    _page(client)
    body = {"client_id": client_id_of("limits"),
            "batch_id": batch_id_of("limits_replay_01"),
            "ops": [_create(FINE_BLK_01, "fine text")]}
    first = client.post("/api/ops", json=body)
    assert first.status_code == 200, first.text
    # a deploy lowers the cap below the stored text
    monkeypatch.setattr(text_limits, "MAX_BLOCK_TEXT_CHARS", 3)
    retry = client.post("/api/ops", json=body)
    assert retry.status_code == 200, retry.text
    assert retry.json() == first.json()


def test_a_reused_batch_id_is_409_even_when_the_judges_refuse(
        client, monkeypatch):
    _page(client)
    batch_id = batch_id_of("limits_replay_02")
    first = client.post("/api/ops", json={
        "client_id": client_id_of("limits"), "batch_id": batch_id,
        "ops": [_create(FINE_BLK_01, "fine text")]})
    assert first.status_code == 200, first.text
    r = client.post("/api/ops", json={
        "client_id": client_id_of("limits"), "batch_id": batch_id,
        "ops": [_create(OVER_LEN_01, "x" * 1_000_001)]})
    assert r.status_code == 409, r.text[:500]
    assert r.json()["detail"] == {
        "index": None,
        "reason": "batch_id was already used with different ops"}


def test_a_refused_batch_never_stored_is_still_400(client, monkeypatch):
    monkeypatch.setattr(text_limits, "MAX_BLOCK_TEXT_CHARS", 3)
    r = _post(client, _create(FINE_BLK_01, "fine text"))
    assert r.status_code == 400, r.text[:500]


def test_a_huge_page_title_hint_lands_a_header_within_the_cap(
        client, seeded_config):
    r = _post(client, {"op": "update_text", "uid": MISSING_001,
                       "text": "edit", "page_title": "h" * 3_000_000})
    assert r.status_code == 200, r.text[:500]
    con = open_db(seeded_config.db_path)
    try:
        row = con.select_one("SELECT max(length(text)) AS n FROM blocks")
    finally:
        con.close()
    assert row is not None
    assert row["n"] <= MAX_BLOCK_TEXT_CHARS


# An edit whose replay would be over a limit lands as a conflict entry. The
# replay it skipped had unlinked or renamed titles away; landed as sent,
# its links would re-create those pages.

def _today_conflicts(client) -> list[tuple[str, list[str]]]:
    r = client.get(f"/api/page/{title_for_date(date.today())}")
    if r.status_code == 404:
        return []
    return [(b["text"], [c["text"] for c in b["children"]])
            for b in r.json()["blocks"]
            if b["text"].startswith("[[conflict]]")]


def _replay_skipped_over_limit(client, uid: BlockUid, base: str,
                               text: str) -> None:
    r = _post(client, {"op": "update_text", "uid": uid, "text": text,
                       "base_text_hash": text_hash(base)})
    assert r.status_code == 200, r.text[:500]
    assert [(s["uid"], s["reason"]) for s in r.json()["skipped"]] == [
        (uid, "text_limit")]


def test_an_over_limit_replay_after_a_delete_does_not_recreate_the_page(
        client):
    _page(client)
    source, referrer = uid_of("rp_src_0001"), uid_of("rp_ref_0001")
    original = f"[[RpDel]] (({source}))"
    r = _post(client,
              {"op": "create", "uid": source, "page_title": "RpDel",
               "parent_uid": None, "order_idx": 0, "text": "d" * 600_000},
              _create(referrer, original))
    assert r.status_code == 200, r.text[:500]
    assert client.delete("/api/page/RpDel").status_code == 200

    _replay_skipped_over_limit(client, referrer, original,
                               f"[[RpDel]] (({source})) (({source}))")

    assert client.get("/api/page/RpDel").status_code == 404
    [(_, [landed])] = _today_conflicts(client)
    assert landed == f"RpDel (({source})) (({source}))"


def test_an_over_limit_replay_after_a_rename_does_not_recreate_the_old_title(
        client):
    _page(client)
    referrer = uid_of("rp_ref_0002")
    original = "[[Old]] " * 900
    assert _post(client, _create(referrer, original)).status_code == 200
    r = client.post("/api/page/Old/rename", json={"new_title": "n" * 1000})
    assert r.status_code == 200, r.text[:500]

    _replay_skipped_over_limit(client, referrer, original, "[[Old]] " * 1000)

    assert client.get("/api/page/Old").status_code == 404
    [(_, [landed])] = _today_conflicts(client)
    assert landed == "Old " * 1000


def test_an_over_limit_replay_unlinks_titles_past_the_step_it_stopped_at(
        client):
    # The rename's step is over the cap; the later delete of RpX is a step
    # the replay never reached, and its title must not come back either.
    _page(client)
    referrer = uid_of("rp_ref_0003")
    original = "[[RpX]] " + "[[Old]] " * 900
    assert _post(client, _create(referrer, original)).status_code == 200
    r = client.post("/api/page/Old/rename", json={"new_title": "n" * 1000})
    assert r.status_code == 200, r.text[:500]
    assert client.delete("/api/page/RpX").status_code == 200

    _replay_skipped_over_limit(client, referrer, original,
                               "[[RpX]] " + "[[Old]] " * 1000)

    assert client.get("/api/page/RpX").status_code == 404
    assert client.get("/api/page/Old").status_code == 404
    [(_, [landed])] = _today_conflicts(client)
    assert landed == "RpX " + "Old " * 1000


def test_an_over_limit_replay_judges_the_nesting_its_copies_join(client):
    # The delete inlined two copies that each hold half the nesting cap:
    # one opens its runs, the other closes them. The stale edit refers to
    # each twice, so its replay would nest past the cap before the unlink
    # peels it: judged there, it lands as sent with the title unlinked.
    _page(client)
    half = MAX_LINK_NESTING // 2
    opens, closes = uid_of("rp_open_001"), uid_of("rp_close_01")
    referrer = uid_of("rp_ref_0004")
    original = f"(({opens})) [[RpNest]] (({closes}))"
    r = _post(client,
              *({"op": "create", "uid": uid, "page_title": "RpNest",
                 "parent_uid": None, "order_idx": order_idx_of(i),
                 "text": text}
                for i, (uid, text) in enumerate(
                    [(opens, "[[" * half), (closes, "]]" * half)])),
              _create(referrer, original))
    assert r.status_code == 200, r.text[:500]
    assert client.delete("/api/page/RpNest").status_code == 200
    stored = _block_text(client, referrer)

    stale = f"(({opens}))" * 2 + "[[RpNest]]" + f"(({closes}))" * 2
    _replay_skipped_over_limit(client, referrer, original, stale)

    assert client.get("/api/page/RpNest").status_code == 404
    assert _block_text(client, referrer) == stored
    [(_, [landed])] = _today_conflicts(client)
    assert landed == f"(({opens}))" * 2 + "RpNest" + f"(({closes}))" * 2


def _plain_space_titles(config) -> None:
    con = open_db(config.db_path)
    try:
        set_plain_space_title_canonicalization(con, True)
        con.commit()
    finally:
        con.close()


def test_an_over_limit_replay_unlinks_a_padded_renamed_away_title(
        client, seeded_config):
    # Under plain-space titles `[[ Old ]]` is the page Old, as the rename
    # that retitled it matched. The landing must match it the same way.
    _plain_space_titles(seeded_config)
    _page(client)
    referrer = uid_of("rp_ref_0004")
    original = "[[Old]] " * 900
    assert _post(client, _create(referrer, original)).status_code == 200
    r = client.post("/api/page/Old/rename", json={"new_title": "n" * 1000})
    assert r.status_code == 200, r.text[:500]

    _replay_skipped_over_limit(client, referrer, original,
                               "[[Old]] " * 1000 + "[[ Old ]]")

    assert client.get("/api/page/Old").status_code == 404
    [(_, [landed])] = _today_conflicts(client)
    assert landed == "Old " * 1000 + " Old "
