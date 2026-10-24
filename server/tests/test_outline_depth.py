"""The outline depth cap: /api/ops refuses a batch whose create or move
would put a block past MAX_OUTLINE_DEPTH, so no reader has to survive an
outline deeper than that. A top-level block sits at level 1. What the
server lands itself (conflict entries, a diverged delete's copies) is never
refused, and never lands past the cap either."""
import itertools
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import quote

from fastapi.testclient import TestClient

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (MAX_OUTLINE_DEPTH, BlockUid, OrderIdx,
                               text_hash)
from pkm.contracts.titles import RawTitle
from pkm.server.config import Config
from pkm.server.db import open_db
from pkm.server.sync_meta import read_title
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


@dataclass(frozen=True)
class _Placed:
    uid: BlockUid
    parent_uid: BlockUid | None
    order_idx: OrderIdx
    text: str
    level: int


def _placed(config: Config, title: RawTitle) -> list[_Placed]:
    """Every block of the page with its level, in document order."""
    con = open_db(config.db_path)
    try:
        rows = con.select(
            "SELECT b.uid, b.parent_uid, b.order_idx, b.text FROM blocks b"
            " JOIN pages p ON p.id = b.page_id WHERE p.title = ?",
            (read_title(con, title),))
    finally:
        con.close()
    children: dict[BlockUid | None, list] = {}
    for row in rows:
        children.setdefault(row["parent_uid"], []).append(row)
    out: list[_Placed] = []

    def walk(parent: BlockUid | None, level: int) -> None:
        for row in sorted(children.get(parent, ()),
                          key=lambda r: (r["order_idx"], r["uid"])):
            out.append(_Placed(row["uid"], row["parent_uid"],
                               row["order_idx"], row["text"], level))
            walk(row["uid"], level + 1)

    walk(None, 1)
    assert len(out) == len(rows)
    return out


def _by_text(placed: list[_Placed], text: str) -> _Placed:
    (found,) = [p for p in placed if p.text == text]
    return found


def _stale_delete(uid: BlockUid) -> dict:
    return {"op": "delete", "uid": uid,
            "base_subtree_hash": text_hash("stale")}


def test_stacked_diverged_deletes_never_land_past_the_cap(
        client, seeded_config):
    """Each diverged delete copies the subtree one level deeper under a
    fresh top-level header; deleting that header in turn used to stack a
    level per batch until the page read answered 500."""
    today = _today()
    assert _ops(client, *_chain("st", 100, today)).status_code == 200
    target = _uid("st", 1)
    for _ in range(5):
        assert _ops(client, _stale_delete(target)).status_code == 200
        target = _conflict_header(seeded_config, target)
    placed = _placed(seeded_config, today)
    assert max(p.level for p in placed) == MAX_OUTLINE_DEPTH
    page = client.get(f"/api/page/{quote(today)}")
    assert page.status_code == 200, page.text[:200]
    assert _height(page.json()["blocks"]) == MAX_OUTLINE_DEPTH
    assert client.get("/api/journal").status_code == 200


def test_a_diverged_delete_flattens_copies_below_the_cap(
        client, seeded_config):
    """The copies keep their shape to level 100; a copy that would sit
    deeper lands at 100 under its nearest copied ancestor at 99, in
    document order, and no text is lost."""
    today = _today()
    # a 100-level chain, plus a second branch under level 98 that reaches
    # level 100 too
    assert _ops(client, *_chain("fl", 100, today),
                {"op": "create", "uid": "fl_side99", "page_title": today,
                 "parent_uid": _uid("fl", 98), "order_idx": 1,
                 "text": "side 99"},
                {"op": "create", "uid": "fl_side100", "page_title": today,
                 "parent_uid": "fl_side99", "order_idx": 0,
                 "text": "side 100"}).status_code == 200
    r = _ops(client, _stale_delete(_uid("fl", 1)))
    assert r.status_code == 200, r.text[:200]
    assert _count(seeded_config, "fl") == 0

    placed = _placed(seeded_config, today)
    assert max(p.level for p in placed) == MAX_OUTLINE_DEPTH
    texts = [p.text for p in placed]
    for level in range(1, 101):
        assert f"fl {level}" in texts
    assert "side 99" in texts and "side 100" in texts
    # the header is level 1, so the copy of level k sits at k + 1
    assert _by_text(placed, "fl 97").level == 98
    at_99 = _by_text(placed, "fl 98")
    assert at_99.level == 99
    under = [p for p in placed if p.parent_uid == at_99.uid]
    assert [(p.text, p.level) for p in under] == [
        ("fl 99", 100), ("fl 100", 100), ("side 99", 100), ("side 100", 100)]
    assert [p.order_idx for p in under] == [0, 1, 2, 3]


def _make_conflict_header(client: TestClient, config: Config,
                          target: str) -> BlockUid:
    """Today's conflict header for `target`, made by a hashed edit that
    conflicts with its text."""
    r = _ops(client, {"op": "update_text", "uid": target, "text": "incoming",
                      "base_text_hash": text_hash("seen")})
    assert r.status_code == 200, r.text[:200]
    return _conflict_header(config, uid_of(target))


def _sink_header(client, config: Config, header: BlockUid, level: int,
                 prefix: str) -> None:
    """Put the header at `level` on today's page by direct SQL: no op may
    put a header with entries at the cap, but a legacy row can sit
    there."""
    assert _ops(client, *_chain(prefix, level - 1, _today())
                ).status_code == 200
    _set_parent(config, header, _uid(prefix, level - 1))


def test_a_conflict_note_reuses_a_header_above_the_cap(client, seeded_config):
    assert _ops(client, {"op": "create", "uid": "rh_target",
                         "page_title": "Notes", "order_idx": 0,
                         "text": "server"}).status_code == 200
    header = _make_conflict_header(client, seeded_config, "rh_target")
    _sink_header(client, seeded_config, header, MAX_OUTLINE_DEPTH - 1, "rh")
    before = _children(seeded_config, header)
    r = _ops(client, {"op": "update_text", "uid": "rh_target",
                      "text": "again", "base_text_hash": text_hash("seen")})
    assert r.status_code == 200, r.text[:200]
    assert len(_children(seeded_config, header)) == len(before) + 1
    placed = _placed(seeded_config, _today())
    assert max(p.level for p in placed) == MAX_OUTLINE_DEPTH


def test_a_conflict_note_under_a_header_at_the_cap_gets_a_fresh_header(
        client, seeded_config):
    assert _ops(client, {"op": "create", "uid": "fh_target",
                         "page_title": "Notes", "order_idx": 0,
                         "text": "server"}).status_code == 200
    header = _make_conflict_header(client, seeded_config, "fh_target")
    _sink_header(client, seeded_config, header, MAX_OUTLINE_DEPTH, "fh")
    before = _children(seeded_config, header)
    r = _ops(client, {"op": "update_text", "uid": "fh_target",
                      "text": "again", "base_text_hash": text_hash("seen")})
    assert r.status_code == 200, r.text[:200]
    assert _children(seeded_config, header) == before
    fresh = _conflict_header(seeded_config, uid_of("fh_target"))
    assert fresh != header
    placed = _placed(seeded_config, _today())
    (entry,) = [p for p in placed if p.parent_uid == fresh]
    assert entry.level == 2
    assert next(p for p in placed if p.uid == fresh).level == 1


def test_a_diverged_delete_under_a_header_at_99_lands_flat_beside_its_entry(
        client, seeded_config):
    """Under a reused header at level 99 the root's copy sits at 100, so
    its descendants' copies follow it under the header, in document
    order."""
    notes = raw_title_of("Notes")
    assert _ops(client,
                {"op": "create", "uid": "eh_target", "page_title": notes,
                 "order_idx": 0, "text": "server"},
                {"op": "create", "uid": "eh_child", "page_title": notes,
                 "parent_uid": "eh_target", "order_idx": 0, "text": "child"},
                {"op": "create", "uid": "eh_grand", "page_title": notes,
                 "parent_uid": "eh_child", "order_idx": 0,
                 "text": "grandchild"}).status_code == 200
    header = _make_conflict_header(client, seeded_config, "eh_target")
    _sink_header(client, seeded_config, header, MAX_OUTLINE_DEPTH - 1, "eh")
    before = _children(seeded_config, header)
    r = _ops(client, _stale_delete(uid_of("eh_target")))
    assert r.status_code == 200, r.text[:200]
    placed = _placed(seeded_config, _today())
    assert max(p.level for p in placed) == MAX_OUTLINE_DEPTH
    under = [p for p in placed if p.parent_uid == header]
    assert [p.uid for p in under[:len(before)]] == before
    assert [p.text for p in under[len(before):]] == [
        "incoming", "child", "grandchild"]


def test_skipped_ops_are_not_judged(client, seeded_config):
    r = _ops(client, *_chain("sk", 100, DEEP),
             {"op": "create", "uid": "sk_ghost_child", "page_title": "Deep",
              "parent_uid": "sk_gone_parent", "order_idx": 0, "text": "x"})
    assert r.status_code == 200, r.text[:200]
    assert [(s["index"], s["reason"]) for s in r.json()["skipped"]] == [
        (100, "parent_not_found")]
    assert _count(seeded_config, "sk") == 100
