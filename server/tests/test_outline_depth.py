"""The outline depth cap: /api/ops refuses a batch whose create or move
would put a block past MAX_OUTLINE_DEPTH, so no reader has to survive an
outline deeper than that. A top-level block sits at level 1."""
import itertools
import json
from datetime import date
from pathlib import Path
from urllib.parse import quote

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import MAX_OUTLINE_DEPTH, BlockUid, text_hash
from pkm.contracts.titles import RawTitle
from pkm.server.config import Config
from pkm.server.db import open_db
from pkm.test_data.ids import raw_title_of, uid_of

FIXTURE = (Path(__file__).resolve().parents[2] / "shared" / "fixtures"
           / "outline_depth.json")

_batch_ids = itertools.count()
DEEP = raw_title_of("Deep")


def _ops(client, *ops):
    return client.post("/api/ops", json={
        "client_id": "depth", "batch_id": f"depth_{next(_batch_ids):08d}",
        "ops": list(ops)})


def _uid(prefix: str, level: int) -> BlockUid:
    return uid_of(f"{prefix}_{level:04d}")


def _chain(prefix: str, levels: int, page_title: RawTitle,
           parent: BlockUid | None = None) -> list[dict]:
    """One create per level, each under the one before: level 1 is the
    block under `parent` (top level when None)."""
    ops = []
    for level in range(1, levels + 1):
        uid = _uid(prefix, level)
        ops.append({"op": "create", "uid": uid, "page_title": page_title,
                    "parent_uid": parent, "order_idx": 0,
                    "text": f"{prefix} {level}"})
        parent = uid
    return ops


def _today() -> RawTitle:
    return raw_title_of(title_for_date(date.today()))


def _row(config: Config, uid: BlockUid):
    con = open_db(config.db_path)
    try:
        return con.select_one(
            "SELECT uid, parent_uid, text FROM blocks WHERE uid = ?", (uid,))
    finally:
        con.close()


def _live(config: Config, uid: BlockUid):
    row = _row(config, uid)
    assert row is not None, uid
    return row


def _count(config: Config, prefix: str) -> int:
    con = open_db(config.db_path)
    try:
        row = con.select_one(
            "SELECT COUNT(*) AS n FROM blocks WHERE substr(uid, 1, ?) = ?",
            (len(prefix) + 1, f"{prefix}_"))
        assert row is not None
        return row["n"]
    finally:
        con.close()


def _height(nodes: list[dict]) -> int:
    return max((1 + _height(n["children"]) for n in nodes), default=0)


def _refusal(uid: BlockUid, depth: int) -> str:
    return (f"block {uid} would sit {depth} levels deep;"
            f" the limit is {MAX_OUTLINE_DEPTH}")


def test_the_cap_matches_the_shared_fixture():
    assert MAX_OUTLINE_DEPTH == json.loads(
        FIXTURE.read_text())["max_outline_depth"]


def test_a_create_chain_reaching_100_is_accepted_and_readable(client):
    today = _today()
    r = _ops(client, *_chain("rd", 100, today))
    assert r.status_code == 200, r.text
    page = client.get(f"/api/page/{quote(today)}")
    assert page.status_code == 200, page.text[:200]
    assert _height(page.json()["blocks"]) == 100
    block = client.get(f"/api/block/{_uid('rd', 1)}")
    assert block.status_code == 200, block.text[:200]
    assert _height([block.json()["block"]]) == 100
    journal = client.get("/api/journal")
    assert journal.status_code == 200, journal.text[:200]


def test_a_create_at_level_101_refuses_the_batch(client, seeded_config):
    r = _ops(client, *_chain("ov", 101, DEEP))
    assert r.status_code == 400, r.text[:200]
    assert r.json()["detail"] == {"index": 100,
                                  "reason": _refusal(_uid("ov", 101), 101)}
    assert _count(seeded_config, "ov") == 0


def test_a_batch_that_overflows_after_building_refuses_whole(
        client, seeded_config):
    assert client.post("/api/pages", json={"title": "Deep"}).status_code == 200
    assert _ops(client, *_chain("bu", 100, DEEP)).status_code == 200
    r = _ops(client,
             {"op": "update_text", "uid": _uid("bu", 1), "text": "changed"},
             {"op": "create", "uid": "bu_over", "page_title": "Deep",
              "parent_uid": _uid("bu", 100), "order_idx": 0, "text": "x"})
    assert r.status_code == 400, r.text[:200]
    assert r.json()["detail"] == {"index": 1,
                                  "reason": _refusal(uid_of("bu_over"), 101)}
    assert _live(seeded_config, _uid("bu", 1))["text"] == "bu 1"
    assert _row(seeded_config, uid_of("bu_over")) is None


def test_a_move_counts_the_subtree_height(client, seeded_config):
    assert client.post("/api/pages", json={"title": "Deep"}).status_code == 200
    assert _ops(client, *_chain("ma", 60, DEEP),
                *_chain("mb", 40, DEEP)).status_code == 200
    r = _ops(client, {"op": "move", "uid": _uid("ma", 1),
                      "parent_uid": _uid("mb", 40), "order_idx": 0})
    assert r.status_code == 200, r.text[:200]
    assert _live(seeded_config, _uid("ma", 1))["parent_uid"] == _uid("mb", 40)

    assert _ops(client, *_chain("mc", 60, DEEP),
                *_chain("md", 41, DEEP)).status_code == 200
    r = _ops(client, {"op": "move", "uid": _uid("mc", 1),
                      "parent_uid": _uid("md", 41), "order_idx": 0})
    assert r.status_code == 400, r.text[:200]
    assert r.json()["detail"] == {"index": 0,
                                  "reason": _refusal(_uid("mc", 1), 101)}
    assert _live(seeded_config, _uid("mc", 1))["parent_uid"] is None


def _insert_legacy_chain(config: Config, prefix: str, levels: int,
                         page_title: RawTitle):
    """A chain written straight to the database, as one built before the
    cap would sit there."""
    con = open_db(config.db_path)
    try:
        page = con.select_one("SELECT id AS page_id FROM pages WHERE title = ?",
                              (page_title,))
        assert page is not None
        con.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
            " VALUES (?,?,?,?,?)",
            [(_uid(prefix, level), page["page_id"],
              _uid(prefix, level - 1) if level > 1 else None, 0,
              f"{prefix} {level}") for level in range(1, levels + 1)])
        con.commit()
    finally:
        con.close()


def test_top_level_move_of_a_legacy_overdeep_subtree_is_refused(
        client, seeded_config):
    assert client.post("/api/pages",
                       json={"title": "Legacy"}).status_code == 200
    _insert_legacy_chain(seeded_config, "lg", 120, raw_title_of("Legacy"))
    r = _ops(client, {"op": "update_text", "uid": _uid("lg", 120),
                      "text": "still editable"})
    assert r.status_code == 200, r.text[:200]
    r = _ops(client, {"op": "move", "uid": _uid("lg", 10),
                      "parent_uid": None, "order_idx": 1})
    assert r.status_code == 400, r.text[:200]
    assert r.json()["detail"] == {"index": 0,
                                  "reason": _refusal(_uid("lg", 10), 111)}
    r = _ops(client, {"op": "move", "uid": _uid("lg", 105),
                      "parent_uid": None, "order_idx": 1})
    assert r.status_code == 200, r.text[:200]
    assert _live(seeded_config, _uid("lg", 105))["parent_uid"] is None
    r = _ops(client, {"op": "delete", "uid": _uid("lg", 3)})
    assert r.status_code == 200, r.text[:200]
    assert _row(seeded_config, _uid("lg", 3)) is None


def _set_parent(config: Config, uid: BlockUid, parent_uid: BlockUid) -> None:
    con = open_db(config.db_path)
    try:
        con.execute("UPDATE blocks SET parent_uid = ?, order_idx = 0,"
                    " page_id = (SELECT page_id FROM blocks WHERE uid = ?)"
                    " WHERE uid = ?", (parent_uid, parent_uid, uid))
        con.commit()
    finally:
        con.close()


def _conflict_header(config: Config, target_uid: BlockUid) -> BlockUid:
    con = open_db(config.db_path)
    try:
        row = con.select_one("SELECT header_uid FROM conflict_headers"
                             " WHERE target_uid = ?", (target_uid,))
        assert row is not None
        return row["header_uid"]
    finally:
        con.close()


def _children(config: Config, uid: BlockUid) -> list[BlockUid]:
    con = open_db(config.db_path)
    try:
        return [r["uid"] for r in con.select(
            "SELECT uid FROM blocks WHERE parent_uid = ? ORDER BY order_idx",
            (uid,))]
    finally:
        con.close()


def test_server_landings_are_not_judged(client, seeded_config):
    today = _today()
    # a diverged delete copies the whole 100-level subtree under a fresh
    # header, so its deepest copy lands at level 101
    assert _ops(client, *_chain("dl", 100, today)).status_code == 200
    r = _ops(client, {"op": "delete", "uid": _uid("dl", 1),
                      "base_subtree_hash": text_hash("stale")})
    assert r.status_code == 200, r.text[:200]
    assert _count(seeded_config, "dl") == 0
    page = client.get(f"/api/page/{quote(today)}")
    assert page.status_code == 200, page.text[:200]
    assert _height(page.json()["blocks"]) == 101

    # a conflict note lands under its header, here moved to level 100
    assert _ops(client, {"op": "create", "uid": "cf_target",
                         "page_title": "Notes", "order_idx": 0,
                         "text": "server"}).status_code == 200
    conflict = {"op": "update_text", "uid": "cf_target", "text": "incoming",
                "base_text_hash": text_hash("seen")}
    assert _ops(client, conflict).status_code == 200
    header = _conflict_header(seeded_config, uid_of("cf_target"))
    assert _ops(client, *_chain("hd", 99, today)).status_code == 200
    _set_parent(seeded_config, header, _uid("hd", 99))
    before = _children(seeded_config, header)
    r = _ops(client, {**conflict, "text": "again"})
    assert r.status_code == 200, r.text[:200]
    assert len(_children(seeded_config, header)) == len(before) + 1


def test_skipped_ops_are_not_judged(client, seeded_config):
    r = _ops(client, *_chain("sk", 100, DEEP),
             {"op": "create", "uid": "sk_ghost_child", "page_title": "Deep",
              "parent_uid": "sk_gone_parent", "order_idx": 0, "text": "x"})
    assert r.status_code == 200, r.text[:200]
    assert [(s["index"], s["reason"]) for s in r.json()["skipped"]] == [
        (100, "parent_not_found")]
    assert _count(seeded_config, "sk") == 100
