from __future__ import annotations

import dataclasses
import re
from datetime import datetime
from zoneinfo import ZoneInfo
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rawread import read
from pkm.contracts.ops import BatchId, BlockUid, text_hash
from pkm.server.app import create_app
from proptest import sync_server
from proptest.sync_server import (FIXTURE_PAGE, FIXTURE_UIDS, PASSWORD, SECOND_UIDS,
                                  SEED_UIDS, START_MS, Clock, build_app)
from pkm.test_data.ids import batch_id_of, uid_of
from pkm.database import connect
from pkm.rows import KEYS


@pytest.fixture()
def clock() -> Iterator[Clock]:
    c = Clock()
    yield c
    c.stop()


@pytest.fixture()
def client(tmp_path: Path, clock: Clock) -> Iterator[TestClient]:
    with TestClient(build_app(tmp_path, clock)) as c:
        assert c.post("/api/login", json={"password": PASSWORD}).status_code in (200, 204)
        yield c


def _create(uid: BlockUid, batch_id: BatchId) -> dict:
    return {"client_id": "t", "batch_id": batch_id, "ops": [
        {"op": "create", "uid": uid, "page_title": "Proptest", "parent_uid": None,
         "order_idx": 0, "text": "x"}]}


def _post(client: TestClient, uid: BlockUid, batch_id: BatchId) -> None:
    r = client.post("/api/ops", json=_create(uid, batch_id))
    assert r.status_code == 200, r.text


def test_reset_gives_a_fresh_seeded_db(client: TestClient) -> None:
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    r = client.post("/__proptest/reset")
    assert r.status_code == 200
    snap = client.get("/api/sync/snapshot").json()
    blocks = snap["blocks"]
    assert sorted(b["uid"] for b in blocks) == sorted(
        SEED_UIDS + SECOND_UIDS + FIXTURE_UIDS)
    assert sorted(p["title"] for p in snap["pages"]) == sorted(["Proptest", "Second", FIXTURE_PAGE])
    assert client.get("/__proptest/applied").json() == []


def test_seed_is_ordered_and_has_refs_consistent_with_the_journal(client: TestClient) -> None:
    client.post("/__proptest/reset")
    con = connect(client.post("/__proptest/reset").json()["db_path"])
    for title, uids in (("Proptest", SEED_UIDS), ("Second", SECOND_UIDS),
                        (FIXTURE_PAGE, FIXTURE_UIDS)):
        rows = con.select(
            "SELECT b.uid, b.order_idx, b.parent_uid FROM blocks b JOIN pages p"
            " ON p.id = b.page_id WHERE p.title = ? ORDER BY b.order_idx", (title,))
        assert rows == [{"uid": uid, "order_idx": i * 10, "parent_uid": None}
                        for i, uid in enumerate(uids)]
    assert read(con, "SELECT COUNT(*) FROM changes").fetchone()[0] >= 9
    assert read(con, "SELECT COUNT(*) FROM applied_batches").fetchone()[0] == 0


def test_clock_sets_applied_at(client: TestClient) -> None:
    assert client.post("/__proptest/clock", json={"ms": START_MS + 5000}).json() == {"ms": START_MS + 5000}
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    assert client.get("/__proptest/applied").json() == [
        {"batch_id": "batch_extra_01", "applied_at": START_MS + 5000}]


def test_reset_restores_the_start_clock(client: TestClient) -> None:
    client.post("/__proptest/clock", json={"ms": START_MS + 99_000})
    client.post("/__proptest/reset")
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    assert client.get("/__proptest/applied").json()[0]["applied_at"] == START_MS


def test_rotate_generation_changes_snapshot_generation(client: TestClient) -> None:
    before = client.get("/api/sync/snapshot").json()
    rotated = client.post("/__proptest/rotate-generation").json()["generation"]
    after = client.get("/api/sync/snapshot").json()
    gen_key = next(k for k in after if "generation" in k)
    assert after[gen_key] == rotated != before[gen_key]


def test_applied_is_in_commit_order(client: TestClient) -> None:
    ids = ["batch_zz_001", "batch_aa_002", "batch_mm_003"]
    for i, bid in enumerate(ids):
        _post(client, uid_of(f"pt_extra_{i}"), batch_id_of(bid))
    assert [a["batch_id"] for a in client.get("/__proptest/applied").json()] == ids


def test_session_survives_reset_and_clock_moves(client: TestClient) -> None:
    client.post("/__proptest/reset")
    client.post("/__proptest/clock", json={"ms": START_MS + 2 * 24 * 3600 * 1000})
    assert client.get("/api/sync/snapshot").status_code == 200


def test_proptest_routes_need_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.post("/__proptest/reset").status_code == 401
        assert anon.get("/__proptest/applied").status_code == 401


def test_proptest_routes_are_not_in_the_product_app(tmp_path: Path, clock: Clock) -> None:
    app = build_app(tmp_path, clock)
    template = tmp_path / "t.sqlite3"
    product = create_app(dataclasses.replace(app.state.config, db_path=template))
    assert not [r for r in product.routes if "/__proptest" in getattr(r, "path", "")]
    assert [r for r in app.routes if "/__proptest" in getattr(r, "path", "")]


def test_server_log_path_honours_override(tmp_path: Path) -> None:
    assert sync_server.log_path({"PROPTEST_SERVER_LOG": "/x/y.log"}, tmp_path) == Path("/x/y.log")
    assert sync_server.log_path({}, tmp_path) == tmp_path / "server.log"


def test_cookie_from_start_survives_every_clock_the_harness_uses(client: TestClient) -> None:
    def local_ms(y: int, m: int, d: int) -> int:
        return int(datetime(y, m, d, 23, 59, 55, tzinfo=ZoneInfo("Europe/London")).timestamp() * 1000)

    for ms in (local_ms(2026, 3, 29), local_ms(2026, 10, 25), START_MS + 300 * 24 * 3600 * 1000):
        client.post("/__proptest/clock", json={"ms": ms})
        assert client.get("/api/sync/snapshot").status_code == 200
        assert client.post("/__proptest/reset").status_code == 200
        assert client.get("/api/sync/snapshot").status_code == 200


def _rename(client: TestClient, old: str, new: str) -> int:
    return client.post(f"/api/page/{old}/rename",
                       json={"new_title": new, "allow_merge": False}).status_code


def test_renames_are_logged_after_the_last_applied_batch_at_the_server_clock(
        client: TestClient) -> None:
    con = connect(client.post("/__proptest/reset").json()["db_path"])
    assert client.get("/__proptest/renames").json() == []
    client.post("/__proptest/clock", json={"ms": START_MS + 1000})
    assert _rename(client, "Second", "Third") == 200
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    _post(client, uid_of("pt_extra_2"), batch_id_of("batch_extra_02"))
    client.post("/__proptest/clock", json={"ms": START_MS + 2000})
    assert _rename(client, "Third", "Second") == 200
    # A refused rename retitles nothing, so it logs nothing.
    assert _rename(client, "Second", "Proptest") == 409
    assert _rename(client, "Nowhere", "Fourth") == 404
    assert read(con, "SELECT after_batch FROM proptest_renames ORDER BY rowid").fetchall() == [
        (0,), (read(con, "SELECT MAX(rowid) FROM applied_batches").fetchone()[0],)]
    assert client.get("/__proptest/renames").json() == [
        {"old_title": "Second", "new_title": "Third", "after_batch_id": None,
         "at": START_MS + 1000, "ord": 1},
        {"old_title": "Third", "new_title": "Second", "after_batch_id": "batch_extra_02",
         "at": START_MS + 2000, "ord": 2},
    ]
    # The log is the harness's own: the snapshot the oracle compares has no
    # trace of it, and a reset empties it.
    assert "proptest_renames" not in client.get("/api/sync/snapshot").text
    client.post("/__proptest/reset")
    assert client.get("/__proptest/renames").json() == []


def test_renames_route_needs_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.get("/__proptest/renames").status_code == 401


def _delete(client: TestClient, title: str) -> int:
    return client.delete(f"/api/page/{title}").status_code


def test_deletes_are_logged_with_the_uids_the_page_held_in_order_with_renames(
        client: TestClient) -> None:
    con = connect(client.post("/__proptest/reset").json()["db_path"])
    assert client.get("/__proptest/deletes").json() == []
    client.post("/__proptest/clock", json={"ms": START_MS + 1000})
    assert _rename(client, "Second", "Third") == 200
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    client.post("/__proptest/clock", json={"ms": START_MS + 2000})
    # A block removed by an op before the delete is not what the delete removed.
    gone = {"client_id": "t", "batch_id": "batch_gone_01", "ops": [
        {"op": "delete", "uid": "pt_seed_1"}]}
    assert client.post("/api/ops", json=gone).status_code == 200
    assert _delete(client, "Proptest") == 200
    assert _delete(client, "Nowhere") == 404
    assert _rename(client, "Third", "Second") == 200
    deletes = client.get("/__proptest/deletes").json()
    assert len(deletes) == 1
    record = deletes[0]
    assert record["title"] == "Proptest"
    assert record["after_batch_id"] == "batch_gone_01"
    assert record["at"] == START_MS + 2000
    deleted = con.select_one(
        "SELECT seq FROM page_deletions WHERE title = 'Proptest'")
    assert deleted is not None
    assert record["seq"] == deleted["seq"]
    assert sorted(record["uids"]) == sorted(
        [u for u in SEED_UIDS if u != "pt_seed_1"] + ["pt_extra_1"])
    renames = client.get("/__proptest/renames").json()
    assert [r["ord"] for r in renames] == [1, 3]
    assert record["ord"] == 2
    client.post("/__proptest/reset")
    assert client.get("/__proptest/deletes").json() == []


def test_deletes_route_needs_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.get("/__proptest/deletes").status_code == 401


def _take(client: TestClient) -> list[dict] | None:
    r = client.post("/__proptest/echo/take")
    assert r.status_code == 200, r.text
    return r.json()["ops"]


def _batch(batch_id: BatchId, ops: list[dict]) -> dict:
    return {"client_id": "t", "batch_id": batch_id, "ops": ops}


def _move_to_second(batch_id: BatchId) -> dict:
    return _batch(batch_id, [
        {"op": "move", "uid": SEED_UIDS[0], "parent_uid": None, "order_idx": 0,
         "page_title": "Second"}])


def test_echo_take_returns_the_last_batch_ops_then_none(client: TestClient) -> None:
    assert _take(client) is None
    r = client.post("/api/ops", json=_batch(batch_id_of("batch_echo_01"), [
        {"op": "create_page", "page_title": "Echo Page"},
        {"op": "create", "uid": "pt_echo_1", "page_title": "Echo Page", "parent_uid": None,
         "order_idx": 0, "text": "x"}]))
    assert r.status_code == 200, r.text
    ops = _take(client)
    assert ops is not None and [o["op"] for o in ops] == ["create_page", "create"]
    assert all(o["page_title"] == "Echo Page" for o in ops)
    assert _take(client) is None


def test_echo_take_is_none_after_a_rejected_batch(client: TestClient) -> None:
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    assert _take(client) is not None
    r = client.post("/api/ops", json=_create(uid_of(SEED_UIDS[0]), batch_id_of("batch_extra_02")))
    assert r.status_code == 400
    assert _take(client) is None


def test_echo_is_cleared_by_reset(client: TestClient) -> None:
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    client.post("/__proptest/reset")
    assert _take(client) is None


def test_echo_teeth_drops_cross_page_move_titles(client: TestClient) -> None:
    assert client.post("/__proptest/echo/teeth", json={"drop_cross_page_title": True}).status_code == 200
    assert client.post("/api/ops", json=_move_to_second(batch_id_of("batch_move_01"))).status_code == 200
    ops = _take(client)
    assert ops is not None and ops[0]["op"] == "move" and ops[0]["page_title"] is None
    client.post("/__proptest/reset")
    assert client.post("/api/ops", json=_move_to_second(batch_id_of("batch_move_02"))).status_code == 200
    ops = _take(client)
    assert ops is not None and ops[0]["page_title"] == "Second"


def test_echo_routes_need_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.post("/__proptest/echo/take").status_code == 401
        assert anon.post("/__proptest/echo/teeth", json={"drop_cross_page_title": True}).status_code == 401


def _stale_create(batch_id: BatchId) -> dict:
    # seen_seq 0: made before every delete, so stale for each deleted title.
    return {**_batch(batch_id, [
        {"op": "create", "uid": f"pt_{batch_id}", "page_title": "Second", "parent_uid": None,
         "order_idx": 0, "text": "stale"}]), "seen_seq": 0}


def _titles(client: TestClient) -> set[str]:
    return {p["title"] for p in client.get("/api/sync/snapshot").json()["pages"]}


def test_stale_teeth_make_every_batch_fresh_until_reset(client: TestClient) -> None:
    try:
        assert client.post("/__proptest/stale/teeth", json={"empty": True}).status_code == 200
        assert _delete(client, "Second") == 200
        assert client.post("/api/ops", json=_stale_create(batch_id_of("batch_stale_01"))).status_code == 200
        assert "Second" in _titles(client)
    finally:
        client.post("/__proptest/reset")
    assert _delete(client, "Second") == 200
    assert client.post("/api/ops", json=_stale_create(batch_id_of("batch_stale_02"))).status_code == 200
    assert "Second" not in _titles(client)


def test_stale_teeth_route_needs_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.post("/__proptest/stale/teeth", json={"empty": True}).status_code == 401


def _edit(batch_id: BatchId, text: str, base: str | None = None) -> dict:
    op: dict = {"op": "update_text", "uid": SEED_UIDS[0], "text": text}
    if base is not None:
        op["base_text_hash"] = text_hash(base)
    return _batch(batch_id, [op])


def _chained_edits_after_a_rename(client: TestClient) -> None:
    """One device's chain: it wrote [[Second]] into the block, Second was
    renamed, and two more edits it made before seeing the rename arrive."""
    assert client.post("/api/ops", json=_edit(batch_id_of("batch_chain_01"), "[[Second]] a")).status_code == 200
    assert _rename(client, "Second", "Third") == 200
    for batch_id, (base, text) in (("batch_chain_02", ("[[Second]] a", "[[Second]] b")),
                                   ("batch_chain_03", ("[[Second]] b", "[[Second]] c"))):
        r = client.post("/api/ops", json=_edit(batch_id_of(batch_id), text, base))
        assert r.status_code == 200, r.text


def _text_of(client: TestClient, uid: BlockUid) -> str:
    return next(b["text"] for b in client.get("/api/sync/snapshot").json()["blocks"]
                if b["uid"] == uid)


def test_conflicts_are_logged_with_the_batch_that_wrote_the_header(client: TestClient) -> None:
    assert client.get("/__proptest/conflicts").json() == []
    _post(client, uid_of("pt_extra_1"), batch_id_of("batch_extra_01"))
    edits = [("batch_conflict_01", "theirs"), ("batch_conflict_02", "mine")]
    for batch_id, text in edits:
        r = client.post("/api/ops", json=_edit(batch_id_of(batch_id), text, "seed 1"))
        assert r.status_code == 200, r.text
    logged = client.get("/__proptest/conflicts").json()
    assert len(logged) == 1
    assert logged[0]["batch_id"] == "batch_conflict_02"
    assert logged[0]["text"].endswith(f" — overwritten by (({SEED_UIDS[0]}))")
    header = next(b for b in client.get("/api/sync/snapshot").json()["blocks"]
                  if b["uid"] == logged[0]["header_uid"])
    assert header["text"] == logged[0]["text"] and header["parent_uid"] is None
    # The log keeps the header's uid after a page delete inlines its ref.
    assert _delete(client, "Proptest") == 200
    assert _text_of(client, logged[0]["header_uid"]) != logged[0]["text"]
    assert client.get("/__proptest/conflicts").json() == logged
    assert "proptest_conflicts" not in client.get("/api/sync/snapshot").text
    client.post("/__proptest/reset")
    assert client.get("/__proptest/conflicts").json() == []


def test_conflicts_route_needs_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.get("/__proptest/conflicts").status_code == 401


def test_rewrite_teeth_drop_the_replay_rows_until_reset(client: TestClient) -> None:
    try:
        assert client.post("/__proptest/rewrites/teeth",
                           json={"drop_replayed": True}).status_code == 200
        _chained_edits_after_a_rename(client)
        logged = client.get("/__proptest/conflicts").json()
        assert [c["batch_id"] for c in logged] == ["batch_chain_03"]
        assert logged[0]["text"].endswith(f"(({SEED_UIDS[0]}))")
    finally:
        client.post("/__proptest/reset")
    _chained_edits_after_a_rename(client)
    assert client.get("/__proptest/conflicts").json() == []
    assert _text_of(client, uid_of(SEED_UIDS[0])) == "[[Third]] c"


def test_rewrite_teeth_route_needs_auth(tmp_path: Path, clock: Clock) -> None:
    with TestClient(build_app(tmp_path, clock)) as anon:
        assert anon.post("/__proptest/rewrites/teeth",
                         json={"drop_replayed": True}).status_code == 401


def test_no_harness_alias_puts_another_kind_of_value_under_a_vocabulary_key():
    """`ord AS n` read an ordinal under the count key. An alias to a `Row`
    key outside the harness's own four must name a value of that key's own
    meaning: `j.value` is a block uid out of a JSON array, the one such
    computed value."""
    source = Path(sync_server.__file__).read_text(encoding="utf-8")
    harness = {"applied_rowid", "after_batch_rowid", "log_at", "log_ord"}
    aliased = {(m["expr"], m["alias"]) for m in re.finditer(r"(?P<expr>[\w.]+)\s+AS\s+(?P<alias>\w+)", source)
               if m["alias"] in KEYS}
    assert {a for a in aliased if a[1] not in harness} == {("j.value", "uid")}
    assert {a for a in aliased if a[1] in harness} == {
        ("rowid", "applied_rowid"), ("after_batch", "after_batch_rowid"),
        ("at", "log_at"), ("ord", "log_ord"), ("d.ord", "log_ord")}
