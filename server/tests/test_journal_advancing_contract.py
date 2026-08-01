"""pkm-getl: a mutation-route contract test enumerating every
journal-advancing endpoint (a route whose commit touches blocks, pages, or
sidebar_entries -- the tables with changes-journal triggers, schema.py
SERVER_DDL). Each one must emit a WS seq nudge after its commit; the journal
cleanup route (routes_pages.py cleanup_journal) shipped without one and
replicas kept deleted pages until an unrelated mutation nudged them.

This list is the enforcement mechanism: nothing makes a new route emit its
nudge automatically (see notify.py's commit_and_nudge_threadpool for the
closest thing -- pairing commit+nudge in one call so there's one line to
remember instead of two), so a route that starts writing to a journaled
table without adding a case here is a silent contract violation.
If you add or change a journal-advancing route, add or update its entry.

Asset routes are USUALLY the exception: they write to `assets`, which has
no changes-journal trigger, so `upload_asset`'s commit needs no nudge (and
sends none). But `delete_asset` conditionally writes to `blocks` too --
stripping or removing any block that references the deleted asset -- so in
that branch it IS a journal-advancing route exactly like the others, and
belongs in the list below with a scenario that exercises it (an
asset-with-a-referencing-block, not a bare orphan delete).

Each entry's `setup` runs BEFORE the WS connects (so its own nudges, if
any, don't get mistaken for the `action`'s), and `action` runs after,
performing the route under test.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from pkm.server.config import Config
from pkm.server.daily import title_for_date

# conftest seeds this fixed daily title (page id 3); routes below must
# avoid colliding with it (pages.title is UNIQUE).
_SEEDED_DAILY_TITLE = "July 7th, 2026"


def _non_colliding_daily_title(days_ago_range: range) -> str:
    for days_ago in days_ago_range:
        title = title_for_date(date.today() - timedelta(days=days_ago))
        if title != _SEEDED_DAILY_TITLE:
            return title
    raise AssertionError(  # pragma: no cover - defensive only
        "no non-colliding day found in range")


def _noop_setup(_client: TestClient, _config: Config, _ctx: dict) -> None:
    pass


def _ops_action(client: TestClient, _config: Config, _ctx: dict):
    return client.post("/api/ops", json={
        "client_id": "contract", "batch_id": "contract_ops",
        "ops": [{"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]})


def _get_page_autocreate_action(client: TestClient, _config: Config, _ctx: dict):
    return client.get(f"/api/page/{title_for_date(date.today())}")


def _get_journal_autocreate_action(client: TestClient, _config: Config, _ctx: dict):
    return client.get("/api/journal?days=1")


def _create_page_action(client: TestClient, _config: Config, _ctx: dict):
    return client.post("/api/pages", json={"title": "Contract Create Page"})


def _delete_page_setup(client: TestClient, _config: Config, _ctx: dict) -> None:
    client.post("/api/pages", json={"title": "Contract Delete Page"})


def _delete_page_action(client: TestClient, _config: Config, _ctx: dict):
    return client.delete("/api/page/Contract Delete Page")


def _rename_page_setup(client: TestClient, _config: Config, _ctx: dict) -> None:
    client.post("/api/pages", json={"title": "Contract Rename Src"})


def _rename_page_action(client: TestClient, _config: Config, _ctx: dict):
    return client.post("/api/page/Contract Rename Src/rename",
                       json={"new_title": "Contract Rename Dst"})


def _cleanup_journal_setup(_client: TestClient, config: Config, _ctx: dict) -> None:
    # A page dated 1-7 days ago with no blocks: cleanup_journal deletes it.
    # Inserted directly (not through the app) so this setup itself can't
    # emit a nudge to be mistaken for the action's.
    title = _non_colliding_daily_title(range(1, 8))
    con = sqlite3.connect(config.db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (980, title))
    con.commit()
    con.close()


def _cleanup_journal_action(client: TestClient, _config: Config, _ctx: dict):
    return client.post("/api/journal/cleanup")


def _add_sidebar_entry_action(client: TestClient, _config: Config, _ctx: dict):
    return client.post("/api/sidebar", json={"title": "Contract Sidebar Add"})


def _delete_sidebar_entry_setup(client: TestClient, _config: Config, ctx: dict) -> None:
    added = client.post("/api/sidebar",
                        json={"title": "Contract Sidebar Delete"})
    ctx["entry_id"] = added.json()["id"]


def _delete_sidebar_entry_action(client: TestClient, _config: Config, ctx: dict):
    return client.delete(f"/api/sidebar/{ctx['entry_id']}")


def _reorder_sidebar_setup(client: TestClient, _config: Config, ctx: dict) -> None:
    added = client.post("/api/sidebar",
                        json={"title": "Contract Sidebar Reorder"})
    ctx["entry_id"] = added.json()["id"]


def _reorder_sidebar_action(client: TestClient, _config: Config, ctx: dict):
    return client.put("/api/sidebar", json={"order": [ctx["entry_id"]]})


def _delete_asset_with_referencing_block_setup(
        client: TestClient, _config: Config, ctx: dict) -> None:
    """The scenario the earlier version of this file missed: an asset with
    a block that references it. delete_asset strips the token from that
    block's text and UPDATEs it (routes_assets.py ~184-188) -- a `blocks`
    write, journal-triggered like any other -- whereas deleting an
    unreferenced ("orphan") asset touches only the non-journaled `assets`
    table. Only this referencing-block branch actually proves the nudge is
    load-bearing rather than incidental."""
    upload = client.post("/api/assets", files={
        "file": ("note.txt", b"contract asset", "text/plain")})
    asset = upload.json()
    ctx["sha256"] = asset["sha256"]
    r = client.post("/api/ops", json={
        "client_id": "contract", "batch_id": "contract_asset_ref",
        "ops": [{"op": "create", "uid": "contract_asset_ref_blk",
                 "page_title": "AI", "parent_uid": None, "order_idx": 5,
                 "text": f"see ![]({asset['url']})"}]})
    assert r.status_code == 200, r.text


def _delete_asset_with_referencing_block_action(
        client: TestClient, _config: Config, ctx: dict):
    r = client.delete(f"/api/assets/{ctx['sha256']}")
    # Confirms this run actually took the referencing-block (blocks-writing)
    # branch, not the orphan-delete (assets-only) branch -- otherwise this
    # entry would silently degrade into a duplicate of the orphan case.
    if r.status_code < 400:
        assert r.json()["refs_removed"] == 1, r.json()
    return r


# Every journal-advancing route (see module docstring). Adding a route here
# is the enforcement: a new route that writes to blocks/pages/sidebar_entries
# without a corresponding case is an uncovered contract violation.
JOURNAL_ADVANCING_ROUTES: list[tuple[str, Callable, Callable]] = [
    ("POST /api/ops", _noop_setup, _ops_action),
    ("GET /api/page/{title} (today autocreate)",
     _noop_setup, _get_page_autocreate_action),
    ("GET /api/journal (today autocreate)",
     _noop_setup, _get_journal_autocreate_action),
    ("POST /api/pages", _noop_setup, _create_page_action),
    ("DELETE /api/page/{title}", _delete_page_setup, _delete_page_action),
    ("POST /api/page/{title}/rename", _rename_page_setup, _rename_page_action),
    ("POST /api/journal/cleanup",
     _cleanup_journal_setup, _cleanup_journal_action),
    ("POST /api/sidebar", _noop_setup, _add_sidebar_entry_action),
    ("DELETE /api/sidebar/{entry_id}",
     _delete_sidebar_entry_setup, _delete_sidebar_entry_action),
    ("PUT /api/sidebar", _reorder_sidebar_setup, _reorder_sidebar_action),
    ("DELETE /api/assets/{sha256} (with referencing block)",
     _delete_asset_with_referencing_block_setup,
     _delete_asset_with_referencing_block_action),
]


@pytest.mark.parametrize("name,setup,action", JOURNAL_ADVANCING_ROUTES,
                         ids=[name for name, _, _ in JOURNAL_ADVANCING_ROUTES])
def test_journal_advancing_route_emits_seq_nudge(name, setup, action, client,
                                                 seeded_config):
    ctx: dict = {}
    setup(client, seeded_config, ctx)
    with client.websocket_connect("/api/ws") as ws:
        r = action(client, seeded_config, ctx)
        assert r.status_code < 400, f"{name}: action failed: {r.text}"
        frames = []
        for _ in range(8):
            frames.append(ws.receive_json())
            if frames[-1].get("type") == "seq":
                break
        else:
            raise AssertionError(f"{name}: no seq nudge in {frames}")
        assert frames[-1]["seq"] > 0
