"""Roam's export writes :block/heading 0 for "no heading" (unlike this
app, which never stores a heading level for plain text); older imports
carried that 0 straight into blocks.heading, and prod still has rows like
it. A response model typed heading as Literal[1,2,3] | None 500s on such a
row. Responses must read a stored 0 as None; anything else out of range
must still fail loudly."""
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from pkm.contracts.responses import BlockNode, SyncBlock
from pkm.server.app import create_app
from pkm.server.db import open_db

TEST_PASSWORD = "test-pw"  # must match conftest.py


def _block_node(**over):
    base = dict(uid="u1", text="hi", heading=0, view_type=None,
               collapsed=False, order_idx=0, created_at=None,
               updated_at=None, children=[])
    base.update(over)
    return base


def test_block_node_reads_stored_heading_zero_as_none():
    assert BlockNode(**_block_node(heading=0)).heading is None  # pyrefly: ignore[bad-argument-type] (a raw stored int, not a HeadingLevel: exactly what StoredHeading exists to coerce)


def test_block_node_still_rejects_an_out_of_range_heading():
    with pytest.raises(ValidationError):
        BlockNode(**_block_node(heading=4))  # pyrefly: ignore[bad-argument-type] (deliberately out of range: asserting ValidationError)


def _sync_block(**over):
    base = dict(uid="u1", page_id=1, parent_uid=None, order_idx=0, text="hi",
               heading=0, view_type=None, collapsed=0, created_at=None,
               updated_at=None, refs=[])
    base.update(over)
    return base


def test_sync_block_reads_stored_heading_zero_as_none():
    assert SyncBlock(**_sync_block(heading=0)).heading is None  # pyrefly: ignore[bad-argument-type] (a raw stored int, not a HeadingLevel: exactly what StoredHeading exists to coerce)


def test_sync_block_still_rejects_an_out_of_range_heading():
    with pytest.raises(ValidationError):
        SyncBlock(**_sync_block(heading=-1))  # pyrefly: ignore[bad-argument-type] (deliberately out of range: asserting ValidationError)


def _insert_legacy_heading_zero_block(seeded_config) -> None:
    con = open_db(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES ('uid_h0', 1, NULL, 2, 'legacy heading-0 block', 0, 0,"
        " NULL, NULL)")
    con.commit()
    con.close()


def _logged_in_client(seeded_config) -> TestClient:
    c = TestClient(create_app(seeded_config))
    assert c.post("/api/login",
                  json={"password": TEST_PASSWORD}).status_code == 200
    return c


def test_page_fetch_200s_on_a_legacy_heading_zero_block(seeded_config):
    _insert_legacy_heading_zero_block(seeded_config)
    c = _logged_in_client(seeded_config)
    r = c.get("/api/page/Machine Learning")
    assert r.status_code == 200
    block = next(b for b in r.json()["blocks"] if b["uid"] == "uid_h0")
    assert block["heading"] is None


def test_sync_snapshot_200s_on_a_legacy_heading_zero_block(seeded_config):
    _insert_legacy_heading_zero_block(seeded_config)
    c = _logged_in_client(seeded_config)
    r = c.get("/api/sync/snapshot")
    assert r.status_code == 200
    block = next(b for b in r.json()["blocks"] if b["uid"] == "uid_h0")
    assert block["heading"] is None


def test_sync_changes_feed_200s_on_a_legacy_heading_zero_block(seeded_config):
    _insert_legacy_heading_zero_block(seeded_config)
    c = _logged_in_client(seeded_config)
    r = c.get("/api/sync/changes?since=0&limit=1000")
    assert r.status_code == 200
    block = next(b for b in r.json()["blocks"] if b["uid"] == "uid_h0")
    assert block["heading"] is None
