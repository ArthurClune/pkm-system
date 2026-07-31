"""pkm-1rb5: a title that normalizes to "" must never mint an unreachable,
blank-titled page. The plain HTTP route (POST /api/pages) already 422s on
these (bean pkm-hjhy) -- but create/create_page/cross-page-move ops call
store.get_or_create_page directly, bypassing that check, and pydantic's
`min_length=1` on page_title lets a whitespace-only string ("\\n", "\\t",
"   ") through untouched.

The ops path must additionally never *reject* a batch for this (pkm-hjhy:
an offline client replays queued batches, and a rejected batch wedges its
queue permanently) -- so unlike the HTTP route, ops resolve a
normalized-empty page_title to a deterministic fallback page instead.
"""
import sqlite3

import pytest

from pkm.server.store import BlankTitleError, get_or_create_page, fetch_page

WHITESPACE_ONLY = "\n\t"
FALLBACK_TITLE = "Untitled"

_batch_counter = 0


def _post_ops(client, *ops):
    global _batch_counter
    _batch_counter += 1
    return client.post("/api/ops",
                       json={"client_id": "c1",
                             "batch_id": f"blank_batch_{_batch_counter:08d}",
                             "ops": list(ops)})


def _titles(config) -> list[str]:
    con = sqlite3.connect(config.db_path)
    try:
        return [r[0] for r in con.execute("SELECT title FROM pages")]
    finally:
        con.close()


def _blank_titles(config) -> list[str]:
    return [t for t in _titles(config) if not t.strip()]


def test_get_or_create_page_raises_on_normalized_empty_title(tmp_path):
    from pkm.schema import DDL
    from pkm.server.db import init_db, open_db

    db_path = tmp_path / "t.sqlite3"
    init_db(db_path)
    db = open_db(db_path)
    db.executescript(DDL)
    with pytest.raises(BlankTitleError):
        get_or_create_page(db, WHITESPACE_ONLY, 123)
    assert fetch_page(db, "") is None
    db.close()


def test_create_op_with_whitespace_only_page_title_does_not_wedge(
        client, seeded_config):
    r = _post_ops(client, {"op": "create", "uid": "blankop01",
                           "page_title": WHITESPACE_ONLY, "parent_uid": None,
                           "order_idx": 0, "text": "body text"})
    assert r.status_code == 200
    assert _blank_titles(seeded_config) == []
    body = client.get(f"/api/page/{FALLBACK_TITLE}").json()
    assert "body text" in [b["text"] for b in body["blocks"]]


def test_create_page_op_with_whitespace_only_title_does_not_wedge(
        client, seeded_config):
    r = _post_ops(client, {"op": "create_page", "page_title": WHITESPACE_ONLY})
    assert r.status_code == 200
    assert _blank_titles(seeded_config) == []
    assert client.get(f"/api/page/{FALLBACK_TITLE}").status_code == 200


def test_create_page_op_blank_title_is_idempotent_onto_the_same_fallback(
        client, seeded_config):
    """Two separate blank-title ops land on the SAME fallback page, not one
    each -- the fallback is a real title that goes through the normal
    get_or_create semantics."""
    _post_ops(client, {"op": "create_page", "page_title": WHITESPACE_ONLY})
    _post_ops(client, {"op": "create_page", "page_title": "   "})
    titles = _titles(seeded_config)
    assert titles.count(FALLBACK_TITLE) == 1


def test_move_op_cross_page_whitespace_only_title_does_not_wedge(
        client, seeded_config):
    # uid_b4 starts top-level on page 3 ("July 7th, 2026"); moving it with a
    # blank-normalizing page_title must land it on the fallback page rather
    # than 400ing the batch or minting a blank page.
    r = _post_ops(client, {"op": "move", "uid": "uid_b4", "parent_uid": None,
                           "order_idx": 0, "page_title": WHITESPACE_ONLY})
    assert r.status_code == 200
    assert _blank_titles(seeded_config) == []
    body = client.get(f"/api/page/{FALLBACK_TITLE}").json()
    assert any("Machine Learning" in b["text"] for b in body["blocks"])


def test_post_pages_route_still_rejects_whitespace_only_title(client):
    """The interactive HTTP route keeps its explicit 4xx (unlike ops)."""
    r = client.post("/api/pages", json={"title": WHITESPACE_ONLY})
    assert r.status_code == 422
