"""pkm-getl: a mutation-route contract test enumerating every
journal-advancing endpoint (a route whose commit touches blocks, pages, or
sidebar_entries -- the tables with changes-journal triggers, schema.py
SERVER_DDL). Each one must emit a WS seq nudge after its commit; the journal
cleanup route (routes_pages.py cleanup_journal) shipped without one and
replicas kept deleted pages until an unrelated mutation nudged them.

This list is the enforcement mechanism: nothing makes a new route emit its
nudge automatically (see notify.py's commit_and_nudge/_threadpool helpers
for the closest thing -- pairing commit+nudge in one call so there's one
line to remember instead of two), so a route that starts writing to a
journaled table without adding a case here is a silent contract violation.
If you add or change a journal-advancing route, add or update its entry.

Asset routes are the deliberate exception: they write to `assets`, which
has no changes-journal trigger, so they aren't listed even though
delete_asset happens to nudge anyway (see routes_assets.py).
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


def _ops_batch(client: TestClient, _config: Config):
    return client.post("/api/ops", json={
        "client_id": "contract", "batch_id": "contract_ops",
        "ops": [{"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]})


def _get_page_autocreate(client: TestClient, _config: Config):
    return client.get(f"/api/page/{title_for_date(date.today())}")


def _get_journal_autocreate(client: TestClient, _config: Config):
    return client.get("/api/journal?days=1")


def _create_page(client: TestClient, _config: Config):
    return client.post("/api/pages", json={"title": "Contract Create Page"})


def _delete_page(client: TestClient, _config: Config):
    client.post("/api/pages", json={"title": "Contract Delete Page"})
    return client.delete("/api/page/Contract Delete Page")


def _rename_page(client: TestClient, _config: Config):
    client.post("/api/pages", json={"title": "Contract Rename Src"})
    return client.post("/api/page/Contract Rename Src/rename",
                       json={"new_title": "Contract Rename Dst"})


def _cleanup_journal(client: TestClient, config: Config):
    # A page dated 1-7 days ago with no blocks: cleanup_journal deletes it.
    title = _non_colliding_daily_title(range(1, 8))
    con = sqlite3.connect(config.db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (980, title))
    con.commit()
    con.close()
    return client.post("/api/journal/cleanup")


def _add_sidebar_entry(client: TestClient, _config: Config):
    return client.post("/api/sidebar", json={"title": "Contract Sidebar Add"})


def _delete_sidebar_entry(client: TestClient, _config: Config):
    added = client.post("/api/sidebar",
                        json={"title": "Contract Sidebar Delete"})
    return client.delete(f"/api/sidebar/{added.json()['id']}")


def _reorder_sidebar(client: TestClient, _config: Config):
    added = client.post("/api/sidebar",
                        json={"title": "Contract Sidebar Reorder"})
    return client.put("/api/sidebar", json={"order": [added.json()["id"]]})


# Every journal-advancing route (see module docstring). Adding a route here
# is the enforcement: a new route that writes to blocks/pages/sidebar_entries
# without a corresponding case is an uncovered contract violation.
JOURNAL_ADVANCING_ROUTES: list[tuple[str, Callable]] = [
    ("POST /api/ops", _ops_batch),
    ("GET /api/page/{title} (today autocreate)", _get_page_autocreate),
    ("GET /api/journal (today autocreate)", _get_journal_autocreate),
    ("POST /api/pages", _create_page),
    ("DELETE /api/page/{title}", _delete_page),
    ("POST /api/page/{title}/rename", _rename_page),
    ("POST /api/journal/cleanup", _cleanup_journal),
    ("POST /api/sidebar", _add_sidebar_entry),
    ("DELETE /api/sidebar/{entry_id}", _delete_sidebar_entry),
    ("PUT /api/sidebar", _reorder_sidebar),
]


@pytest.mark.parametrize("name,perform", JOURNAL_ADVANCING_ROUTES,
                         ids=[name for name, _ in JOURNAL_ADVANCING_ROUTES])
def test_journal_advancing_route_emits_seq_nudge(name, perform, client,
                                                 seeded_config):
    with client.websocket_connect("/api/ws") as ws:
        r = perform(client, seeded_config)
        assert r.status_code < 400, f"{name}: setup/action failed: {r.text}"
        frames = []
        for _ in range(8):
            frames.append(ws.receive_json())
            if frames[-1].get("type") == "seq":
                break
        else:
            raise AssertionError(f"{name}: no seq nudge in {frames}")
        assert frames[-1]["seq"] > 0
