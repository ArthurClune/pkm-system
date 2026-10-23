"""Rename, delete and delete-preview over a block whose `[[` nesting is
deeper than Python's recursion limit.

`/api/ops` refuses such text today, but rows written before that rule (or
by an import) can still hold it, and the page they link to must stay
renamable and deletable. Each route is run at a shallow depth and at the
legacy depth, and both must give the same answer, scaled."""
from __future__ import annotations

import pytest

from pkm.server.db import open_db
from pkm.server.store import reindex_refs_for_text
from pkm.test_data.ids import uid_of

TITLE = "Deep"
LEGACY_UID = uid_of("leg_000001")
DEPTHS = [3, 1200]


def _nested(depth: int, inner: str) -> str:
    return "[[" * depth + inner + "]]" * depth


def _seed(client, config, depth: int) -> None:
    """A legacy block on page "Paper" linking `TITLE` through `depth`
    layers, written straight to the table as a pre-rule row would be."""
    assert client.post("/api/pages", json={"title": TITLE}).status_code < 300
    text = _nested(depth, TITLE)
    con = open_db(config.db_path)
    try:
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES (?,4,NULL,9,?,0)", (LEGACY_UID, text))
        reindex_refs_for_text(con, LEGACY_UID, text, 0)
        con.commit()
    finally:
        con.close()


def _legacy_text(config) -> str:
    con = open_db(config.db_path)
    try:
        row = con.select_one(
            "SELECT text FROM blocks WHERE uid = ?", (LEGACY_UID,))
        assert row is not None
        return row["text"]
    finally:
        con.close()


@pytest.mark.parametrize("depth", DEPTHS)
def test_delete_preview_counts_the_deep_link(client, seeded_config, depth):
    _seed(client, seeded_config, depth)
    r = client.get("/api/delete-preview", params={"title": TITLE})
    assert r.status_code == 200, r.text
    assert r.json() == {"links": 1, "link_pages": 1, "block_refs": 0,
                        "block_ref_pages": 0, "blockers": []}


@pytest.mark.parametrize("depth", DEPTHS)
def test_rename_rewrites_the_innermost_link(client, seeded_config, depth):
    _seed(client, seeded_config, depth)
    r = client.post(f"/api/page/{TITLE}/rename",
                    json={"new_title": "Deeper"})
    assert r.status_code == 200, r.text
    assert _legacy_text(seeded_config) == _nested(depth, "Deeper")


@pytest.mark.parametrize("depth", DEPTHS)
def test_delete_unlinks_every_layer(client, seeded_config, depth):
    _seed(client, seeded_config, depth)
    r = client.delete(f"/api/page/{TITLE}")
    assert r.status_code == 200, r.text
    assert _legacy_text(seeded_config) == TITLE
    assert client.get(f"/api/page/{TITLE}").status_code == 404
