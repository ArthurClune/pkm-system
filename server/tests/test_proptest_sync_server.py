from __future__ import annotations

import dataclasses
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pkm.server.app import create_app
from proptest import sync_server
from proptest.sync_server import PASSWORD, SEED_UIDS, START_MS, Clock, build_app


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


def _create(uid: str, batch_id: str) -> dict:
    return {"client_id": "t", "batch_id": batch_id, "ops": [
        {"op": "create", "uid": uid, "page_title": "Proptest", "parent_uid": None,
         "order_idx": 0, "text": "x"}]}


def _post(client: TestClient, uid: str, batch_id: str) -> None:
    r = client.post("/api/ops", json=_create(uid, batch_id))
    assert r.status_code == 200, r.text


def test_reset_gives_a_fresh_seeded_db(client: TestClient) -> None:
    _post(client, "pt_extra_1", "batch_extra_01")
    r = client.post("/__proptest/reset")
    assert r.status_code == 200
    snap = client.get("/api/sync/snapshot").json()
    blocks = snap["blocks"]
    assert sorted(b["uid"] for b in blocks) == sorted(SEED_UIDS)
    assert [p["title"] for p in snap["pages"]] == ["Proptest"]
    assert client.get("/__proptest/applied").json() == []


def test_seed_is_ordered_and_has_refs_consistent_with_the_journal(client: TestClient) -> None:
    client.post("/__proptest/reset")
    con = sqlite3.connect(client.post("/__proptest/reset").json()["db_path"])
    rows = con.execute("SELECT uid, order_idx, parent_uid FROM blocks ORDER BY order_idx").fetchall()
    assert rows == [(uid, i * 10, None) for i, uid in enumerate(SEED_UIDS)]
    assert con.execute("SELECT COUNT(*) FROM changes").fetchone()[0] >= 6
    assert con.execute("SELECT COUNT(*) FROM applied_batches").fetchone()[0] == 0


def test_clock_sets_applied_at(client: TestClient) -> None:
    assert client.post("/__proptest/clock", json={"ms": START_MS + 5000}).json() == {"ms": START_MS + 5000}
    _post(client, "pt_extra_1", "batch_extra_01")
    assert client.get("/__proptest/applied").json() == [
        {"batch_id": "batch_extra_01", "applied_at": START_MS + 5000}]


def test_reset_restores_the_start_clock(client: TestClient) -> None:
    client.post("/__proptest/clock", json={"ms": START_MS + 99_000})
    client.post("/__proptest/reset")
    _post(client, "pt_extra_1", "batch_extra_01")
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
        _post(client, f"pt_extra_{i}", bid)
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
