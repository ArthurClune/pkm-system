"""Rename, delete and delete-preview over a block whose `[[` nesting is
deeper than Python's recursion limit.

No write path bounds nesting depth. The `/api/ops` title guard judges only
runs that are refs, and a run whose title has an empty `/` segment is no
ref, so `[[a//[[a//...[[Deep]]...]]]]` is accepted however deep it goes.
The page such a block links must stay renamable and deletable.

A link nested in a link (`[[[[Deep]]]]`) is refused by the guard, but rows
stored before that rule may hold one; delete peels it a layer per pass, so
it runs here at a shallow depth only."""
from __future__ import annotations

import sys

import pytest

from pkm.server.db import open_db
from pkm.server.store import reindex_refs_for_text
from pkm.test_data.ids import uid_of
from pkm.unlink import _unlink_pass

TITLE = "Deep"
SOURCE_PAGE = "Paper"
BLOCK_UID = uid_of("deep_000001")
# Past the limit, so a walk that recursed per level would overflow here.
DEEP = sys.getrecursionlimit() + 100


def _peeled(depth: int, inner: str) -> str:
    """`inner` inside `depth` layers of `[[...]]`."""
    return "[[" * depth + inner + "]]" * depth


def _guarded(depth: int, inner: str) -> str:
    """`inner` inside `depth` runs that are no refs (`a//` is unreachable),
    so `/api/ops` accepts the text."""
    return "[[a//" * depth + inner + "]]" * depth


def _create_page(client) -> None:
    assert client.post("/api/pages", json={"title": TITLE}).status_code < 300


def _write_through_ops(client, text: str) -> None:
    _create_page(client)
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": "batch-deep",
        "ops": [{"op": "create", "uid": BLOCK_UID, "page_title": SOURCE_PAGE,
                 "parent_uid": None, "order_idx": 9, "text": text}]})
    assert r.status_code == 200, r.text


def _write_legacy_row(client, config, text: str) -> None:
    """Straight to the table, as a row stored before the guard would be."""
    _create_page(client)
    con = open_db(config.db_path)
    try:
        page = con.select_one(
            "SELECT id AS page_id FROM pages WHERE title = ?", (SOURCE_PAGE,))
        assert page is not None
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES (?,?,NULL,9,?,0)",
            (BLOCK_UID, page["page_id"], text))
        reindex_refs_for_text(con, BLOCK_UID, text, 0)
        con.commit()
    finally:
        con.close()


def _block_text(config) -> str:
    con = open_db(config.db_path)
    try:
        row = con.select_one(
            "SELECT text FROM blocks WHERE uid = ?", (BLOCK_UID,))
        assert row is not None
        return row["text"]
    finally:
        con.close()


def _seed(client, config, shape: str, depth: int) -> None:
    if shape == "guarded":
        _write_through_ops(client, _guarded(depth, "[[Deep]]"))
    else:
        _write_legacy_row(client, config, _peeled(depth, TITLE))


CASES = [("guarded", 3), ("guarded", DEEP), ("legacy", 3)]


@pytest.mark.parametrize("shape,depth", CASES)
def test_delete_preview_counts_the_deep_link(
        client, seeded_config, shape, depth):
    _seed(client, seeded_config, shape, depth)
    r = client.get("/api/delete-preview", params={"title": TITLE})
    assert r.status_code == 200, r.text
    assert r.json() == {"links": 1, "link_pages": 1, "block_refs": 0,
                        "block_ref_pages": 0, "blockers": []}


@pytest.mark.parametrize("shape,depth", [*CASES, ("legacy", DEEP)])
def test_rename_rewrites_the_innermost_link(
        client, seeded_config, shape, depth):
    _seed(client, seeded_config, shape, depth)
    r = client.post(f"/api/page/{TITLE}/rename",
                    json={"new_title": "Deeper"})
    assert r.status_code == 200, r.text
    expected = (_guarded(depth, "[[Deeper]]") if shape == "guarded"
                else _peeled(depth, "Deeper"))
    assert _block_text(seeded_config) == expected


@pytest.mark.parametrize("shape,depth", CASES)
def test_delete_unlinks_the_link(client, seeded_config, shape, depth):
    _seed(client, seeded_config, shape, depth)
    r = client.delete(f"/api/page/{TITLE}")
    assert r.status_code == 200, r.text
    expected = _guarded(depth, TITLE) if shape == "guarded" else TITLE
    assert _block_text(seeded_config) == expected
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_one_unlink_pass_peels_one_layer_past_the_recursion_limit():
    text = _peeled(DEEP, TITLE)
    assert _unlink_pass(text, lambda raw: raw == TITLE) == \
        _peeled(DEEP - 1, TITLE)
