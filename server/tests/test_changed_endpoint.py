"""GET /api/changed: block edit-time listing (pkm-6eea)."""
import time
from datetime import datetime, timezone

import pytest

from pkm.server.db import open_db

TZ = timezone.utc


@pytest.fixture(autouse=True)
def _utc_local_tz(monkeypatch):
    """The route resolves bare 'YYYY-MM-DD' bounds against the system's
    local timezone (datetime.now().astimezone()). Pin it to UTC so this
    file's bare-date fixtures/assertions don't depend on the machine
    running the tests."""
    monkeypatch.setenv("TZ", "UTC")
    time.tzset()
    yield
    time.tzset()

DAY0 = datetime(2026, 9, 22, 12, 0, tzinfo=TZ)   # before the window
DAY1 = datetime(2026, 9, 23, 9, 0, tzinfo=TZ)    # in [since, until)
DAY1_LATE = datetime(2026, 9, 23, 18, 0, tzinfo=TZ)
DAY2 = datetime(2026, 9, 24, 9, 0, tzinfo=TZ)    # exactly at until -> excluded

SINCE = "2026-09-23"
UNTIL = "2026-09-24"


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _set_times(db_path, uid: str, created_at: datetime, updated_at: datetime) -> None:
    con = open_db(db_path)
    con.execute("UPDATE blocks SET created_at = ?, updated_at = ? WHERE uid = ?",
               (_ms(created_at), _ms(updated_at), uid))
    con.commit()
    con.close()


@pytest.fixture()
def changed_client(client, seeded_config):
    ops = [
        {"op": "create", "uid": "new_blk1", "page_title": "AI",
         "parent_uid": None, "order_idx": 10, "text": "created within window"},
        {"op": "create", "uid": "edit_blk1", "page_title": "AI",
         "parent_uid": None, "order_idx": 11, "text": "edited within window"},
        {"op": "create", "uid": "before_blk1", "page_title": "AI",
         "parent_uid": None, "order_idx": 12, "text": "before the window"},
        {"op": "create", "uid": "after_blk1", "page_title": "AI",
         "parent_uid": None, "order_idx": 13, "text": "at/after until"},
        {"op": "create", "uid": "paper_blk1", "page_title": "Paper",
         "parent_uid": None, "order_idx": 14, "text": "another page, in window"},
    ]
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "changed_batch",
                                      "ops": ops})
    assert r.status_code == 200, r.text

    # new_blk1: created and updated inside the window -> "new"
    _set_times(seeded_config.db_path, "new_blk1", DAY1, DAY1)
    # edit_blk1: created before, updated inside the window -> "edited"
    _set_times(seeded_config.db_path, "edit_blk1", DAY0, DAY1_LATE)
    # before_blk1: updated before the window -> excluded
    _set_times(seeded_config.db_path, "before_blk1", DAY0, DAY0)
    # after_blk1: updated exactly at `until` -> excluded (until is exclusive)
    _set_times(seeded_config.db_path, "after_blk1", DAY2, DAY2)
    # paper_blk1: on a different page, inside the window
    _set_times(seeded_config.db_path, "paper_blk1", DAY0, DAY1)
    return client


def test_window_is_inclusive_since_exclusive_until(changed_client):
    r = changed_client.get("/api/changed", params={"since": SINCE, "until": UNTIL})
    assert r.status_code == 200
    body = r.json()
    uids = {i["uid"] for g in body["groups"] for i in g["items"]}
    assert uids == {"new_blk1", "edit_blk1", "paper_blk1"}
    assert body["total"] == 3


def test_since_boundary_is_inclusive(changed_client):
    # new_blk1 sits exactly at DAY1 09:00 -- move since to that instant.
    since_dt = DAY1
    r = changed_client.get("/api/changed", params={
        "since": since_dt.isoformat(), "until": UNTIL})
    body = r.json()
    uids = {i["uid"] for g in body["groups"] for i in g["items"]}
    assert "new_blk1" in uids


def test_new_vs_edited_status(changed_client):
    r = changed_client.get("/api/changed", params={"since": SINCE, "until": UNTIL})
    body = r.json()
    by_uid = {i["uid"]: i["status"] for g in body["groups"] for i in g["items"]}
    assert by_uid["new_blk1"] == "new"
    assert by_uid["edit_blk1"] == "edited"


def test_page_filter(changed_client):
    r = changed_client.get("/api/changed", params={
        "since": SINCE, "until": UNTIL, "page": "Paper"})
    body = r.json()
    uids = {i["uid"] for g in body["groups"] for i in g["items"]}
    assert uids == {"paper_blk1"}
    assert body["total"] == 1


def test_limit_truncates_but_total_is_full_count(changed_client):
    r = changed_client.get("/api/changed", params={
        "since": SINCE, "until": UNTIL, "limit": 1})
    body = r.json()
    shown = sum(len(g["items"]) for g in body["groups"])
    assert shown == 1
    assert body["total"] == 3


def test_limit_is_clamped_to_at_least_one(changed_client):
    r = changed_client.get("/api/changed", params={
        "since": SINCE, "until": UNTIL, "limit": 0})
    assert r.status_code == 200
    shown = sum(len(g["items"]) for g in r.json()["groups"])
    assert shown == 1


def test_pages_are_ordered_by_first_touch(changed_client):
    # paper_blk1 (DAY1 09:00) sorts before edit_blk1's update (DAY1 18:00) but
    # after new_blk1 (DAY1 09:00, same instant, uid tiebreak) -- assert
    # page order follows chronological first-appearance, not title.
    r = changed_client.get("/api/changed", params={"since": SINCE, "until": UNTIL})
    body = r.json()
    page_order = [g["page_title"] for g in body["groups"]]
    assert page_order == ["AI", "Paper"]


def test_until_defaults_to_now(changed_client):
    r = changed_client.get("/api/changed", params={"since": SINCE})
    assert r.status_code == 200
    body = r.json()
    uids = {i["uid"] for g in body["groups"] for i in g["items"]}
    # after_blk1 (DAY2) is in the past relative to "now" in this test run,
    # so an unbounded until includes it too.
    assert {"new_blk1", "edit_blk1", "paper_blk1", "after_blk1"} <= uids


def test_bad_since_is_400(changed_client):
    r = changed_client.get("/api/changed", params={"since": "not-a-date"})
    assert r.status_code == 400
    assert "since" in r.json()["detail"]


def test_since_after_until_is_400(changed_client):
    r = changed_client.get("/api/changed", params={
        "since": "2026-09-24", "until": "2026-09-23"})
    assert r.status_code == 400


def test_since_required(changed_client):
    r = changed_client.get("/api/changed")
    assert r.status_code == 422  # FastAPI's own required-query-param error


def test_response_echoes_resolved_window(changed_client):
    r = changed_client.get("/api/changed", params={"since": SINCE, "until": UNTIL})
    body = r.json()
    assert body["since"] == _ms(DAY1.replace(hour=0))
    assert body["until"] == _ms(DAY2.replace(hour=0))


def test_requires_auth(anon_client):
    assert anon_client.get("/api/changed", params={"since": SINCE}).status_code == 401
