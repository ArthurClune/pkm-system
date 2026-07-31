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

NOTE (review round 1): refs.normalize_title() is deliberately narrow -- it
only touches titles that hold a *control* whitespace char ([\\t\\n\\r\\f\\v]);
a title of plain spaces alone passes through byte for byte (see
test_refs.py::test_normalize_title_leaves_control_free_titles_byte_for_byte).
So "\\n\\t" and "   " do NOT both collapse to "" the same way: "\\n\\t"
contains a control char and normalizes+strips to ""; "   " has none, so
normalize_title returns it unchanged and get_or_create_page must separately
strip leading/trailing whitespace before its emptiness check, or a
spaces-only page_title sails through as a real (if invisible) page title.
Tests below distinguish CONTROL_ONLY (from control whitespace) and
SPACES_ONLY (from plain spaces) so each code path is actually exercised.
"""
import sqlite3

import pytest

from pkm.server.store import BlankTitleError, get_or_create_page, fetch_page

CONTROL_ONLY = "\n\t"          # contains a control ws char
SPACES_ONLY = "   "            # plain spaces only, no control char
CONTROL_ONLY_2 = " \n "        # a *different* string, also control-bearing
WHITESPACE_ONLY = CONTROL_ONLY  # kept for the tests below that don't care which
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


def _fresh_db(tmp_path):
    from pkm.schema import DDL
    from pkm.server.db import init_db, open_db

    db_path = tmp_path / "t.sqlite3"
    init_db(db_path)
    db = open_db(db_path)
    db.executescript(DDL)
    return db


def test_get_or_create_page_raises_on_control_whitespace_only_title(tmp_path):
    db = _fresh_db(tmp_path)
    with pytest.raises(BlankTitleError):
        get_or_create_page(db, CONTROL_ONLY, 123)
    assert fetch_page(db, "") is None
    db.close()


def test_get_or_create_page_raises_on_spaces_only_title(tmp_path):
    """Finding 2 (review round 1): normalize_title() alone leaves a
    spaces-only string untouched (no control char to trigger collapsing),
    so get_or_create_page must strip before its emptiness check or this
    creates a real page literally titled "   "."""
    db = _fresh_db(tmp_path)
    with pytest.raises(BlankTitleError):
        get_or_create_page(db, SPACES_ONLY, 123)
    assert fetch_page(db, SPACES_ONLY) is None
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


def test_create_page_op_with_spaces_only_title_does_not_wedge(
        client, seeded_config):
    """Finding 2: SPACES_ONLY has no control char, so normalize_title()
    alone would leave it as "   " -- a real, visually-blank, unlinkable
    page. Must fall back the same as a control-whitespace-only title."""
    r = _post_ops(client, {"op": "create_page", "page_title": SPACES_ONLY})
    assert r.status_code == 200
    assert SPACES_ONLY not in _titles(seeded_config)
    assert _blank_titles(seeded_config) == []
    assert client.get(f"/api/page/{FALLBACK_TITLE}").status_code == 200


def test_create_page_op_blank_title_is_idempotent_onto_the_same_fallback(
        client, seeded_config):
    """Two separate ops, each with a DIFFERENT title that genuinely
    normalizes to "" (both hold a control whitespace char, so this
    actually exercises convergence rather than two unrelated titles),
    land on the SAME fallback page -- not one each -- and no other page
    is created as a side effect."""
    before = len(_titles(seeded_config))
    _post_ops(client, {"op": "create_page", "page_title": CONTROL_ONLY})
    _post_ops(client, {"op": "create_page", "page_title": CONTROL_ONLY_2})
    titles = _titles(seeded_config)
    assert titles.count(FALLBACK_TITLE) == 1
    assert len(titles) == before + 1  # exactly one new page: the fallback


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


def test_post_pages_route_rejects_spaces_only_title_too(client):
    """Symmetry check (finding 2): the route already strips before calling
    the store (`body.title.strip()`), so this passed before the fix and
    must keep passing after it -- the fix only needed to change the ops
    path, which does not pre-strip."""
    r = client.post("/api/pages", json={"title": SPACES_ONLY})
    assert r.status_code == 422
