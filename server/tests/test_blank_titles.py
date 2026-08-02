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

NOTE (review round 2): round 1's fix over-corrected -- it applied `.strip()`
to the title that gets STORED and LOOKED UP, not just to the blankness
check. That silently changed canonicalization for every non-blank padded
title (production has real pages like `" EvilCorp"` and one with a
trailing space, created back when refs/ops never stripped). Post round-1,
a ref or op naming one of those titles *exactly as stored* stripped first,
missed the padded row (fetch_page is an exact match), and minted a fresh
empty duplicate -- stranding the real page's content and backlinks under
the padded title, reachable only by a byte-exact URL. Blankness and
canonicalization are separate concerns: `"   "` (nothing but padding) is
blank and must fall back; `" EvilCorp"` (padding plus real content) is not
blank and must keep matching itself exactly, the same as before pkm-1rb5.

NOTE (final-review fix wave): two more findings, both in the blast radius
of the BlankTitleError check landing in get_or_create_page.

CRITICAL: refs.extract()'s own "drop a blank ref" check
(`if norm := normalize_title(title)`) has the exact same narrowness gap as
get_or_create_page did before round 1 -- it reuses normalize_title, which
only touches *control* whitespace, so a spaces-only bracket ref like
`[[   ]]` is NOT dropped: extract() yields `Ref(title="   ")`, "non-empty"
by that check even though it is nothing but padding. That ref.title then
reaches get_or_create_page unguarded at the two ref-indexing call sites
(ops_apply.py's ReindexRefs handling, store.py's rewrite_referencing_blocks
used by rename/merge) and raises BlankTitleError -- which neither
routes_ops.py (catches only OpError) nor the rename route (catches only
sqlite3.IntegrityError) handles, so it surfaces as an uncaught HTTP 500.
For the ops path that is strictly worse than either pre-pkm-1rb5 behavior
(silently minting a "   "-titled page) or the 422 pkm-hjhy explicitly
banned from the ops path: a durable batch that will never succeed on
retry, permanently wedging an offline client's queue. The fix skips the
ref entirely at both call sites (no Untitled fallback here -- per
extract()'s own docstring, a blank-normalizing title "is not a reference
at all", so indexing it as one, even onto a fallback page, would be a
phantom backlink).

IMPORTANT: _broadcast_op relayed a blank-normalizing page_title verbatim
even though the server actually resolved it to `"Untitled"` -- a remote
replica keying its refetch on the broadcast `page_title` would look for
(and mint) its own local page under the raw blank string instead of
finding the real "Untitled" page, diverging until the next resync.
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
    with client.websocket_connect("/api/ws") as ws:
        r = _post_ops(client, {"op": "create", "uid": "blankop01",
                               "page_title": WHITESPACE_ONLY, "parent_uid": None,
                               "order_idx": 0, "text": "body text"})
        assert r.status_code == 200
        # Final-review IMPORTANT: the broadcast must carry the RESOLVED
        # title ("Untitled"), not the raw blank one -- a remote replica
        # keys its refetch on this field.
        assert ws.receive_json()["ops"] == [
            {"op": "create", "uid": "blankop01", "page_title": FALLBACK_TITLE,
             "parent_uid": None, "order_idx": 0, "text": "body text",
             "heading": None, "view_type": None}]
    assert _blank_titles(seeded_config) == []
    body = client.get(f"/api/page/{FALLBACK_TITLE}").json()
    assert "body text" in [b["text"] for b in body["blocks"]]


def test_create_page_op_with_whitespace_only_title_does_not_wedge(
        client, seeded_config):
    with client.websocket_connect("/api/ws") as ws:
        r = _post_ops(client, {"op": "create_page", "page_title": WHITESPACE_ONLY})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [
            {"op": "create_page", "page_title": FALLBACK_TITLE}]
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
    with client.websocket_connect("/api/ws") as ws:
        r = _post_ops(client, {"op": "move", "uid": "uid_b4", "parent_uid": None,
                               "order_idx": 0, "page_title": WHITESPACE_ONLY})
        assert r.status_code == 200
        assert ws.receive_json()["ops"] == [
            {"op": "move", "uid": "uid_b4", "parent_uid": None,
             "order_idx": 0, "page_title": FALLBACK_TITLE}]
    assert _blank_titles(seeded_config) == []
    body = client.get(f"/api/page/{FALLBACK_TITLE}").json()
    assert any("Machine Learning" in b["text"] for b in body["blocks"])


def test_post_pages_route_still_rejects_whitespace_only_title(client):
    """The interactive HTTP route keeps its explicit 4xx (unlike ops)."""
    r = client.post("/api/pages", json={"title": WHITESPACE_ONLY})
    assert r.status_code == 422


def test_post_pages_route_rejects_spaces_only_title_too(client):
    """Symmetry check: the interactive route rejects plain-space blankness
    in either activation mode instead of applying the ops fallback policy."""
    r = client.post("/api/pages", json={"title": SPACES_ONLY})
    assert r.status_code == 422


def test_all_creation_boundaries_preserve_plain_space_before_activation(
        client, seeded_config):
    posted = client.post("/api/pages", json={"title": "  Pre Post  "})
    assert _post_ops(
        client, {"op": "create_page", "page_title": "  Pre Create Page  "}
    ).status_code == 200
    assert _post_ops(
        client,
        {"op": "create", "uid": "precreate01", "page_title": "  Pre Create  ",
         "parent_uid": None, "order_idx": 0, "text": "body"},
    ).status_code == 200
    assert _post_ops(
        client,
        {"op": "move", "uid": "uid_b4", "parent_uid": None,
         "order_idx": 0, "page_title": "  Pre Move  "},
    ).status_code == 200
    renamed = client.post(
        "/api/page/Machine Learning/rename",
        json={"new_title": "  Pre Rename  ", "allow_merge": False},
    )

    assert posted.json()["title"] == "  Pre Post  "
    assert renamed.json() == {"result": "renamed", "title": "  Pre Rename  "}
    exact = {"  Pre Post  ", "  Pre Create Page  ", "  Pre Create  ",
             "  Pre Move  ", "  Pre Rename  "}
    titles = set(_titles(seeded_config))
    assert exact <= titles
    assert not {title.strip() for title in exact} & titles


def test_all_creation_boundaries_canonicalize_plain_space_after_activation(
        client, seeded_config):
    audit = client.get("/api/migrations/title-canonicalization").json()
    applied = client.post(
        "/api/migrations/title-canonicalization",
        json={"audit_digest": audit["digest"]},
    )
    assert applied.status_code == 200

    assert client.post("/api/pages", json={"title": "  Post Route  "}).json()[
        "title"
    ] == "Post Route"
    assert _post_ops(
        client, {"op": "create_page", "page_title": "  Create Page Op  "}
    ).status_code == 200
    assert _post_ops(
        client,
        {"op": "create", "uid": "activecreate1", "page_title": "  Create Op  ",
         "parent_uid": None, "order_idx": 0, "text": "body"},
    ).status_code == 200
    assert _post_ops(
        client,
        {"op": "move", "uid": "uid_b4", "parent_uid": None,
         "order_idx": 0, "page_title": "  Move Op  "},
    ).status_code == 200
    renamed = client.post(
        "/api/page/Machine Learning/rename",
        json={"new_title": "  Rename Route  ", "allow_merge": False},
    )

    assert renamed.json() == {"result": "renamed", "title": "Rename Route"}
    titles = _titles(seeded_config)
    assert {"Post Route", "Create Page Op", "Create Op", "Move Op", "Rename Route"} <= set(titles)
    assert not any(title.startswith(" ") or title.endswith(" ") for title in titles)


def test_padded_title_is_preserved_and_reused_exactly(tmp_path):
    """Round-2 regression (review round 2): a title padded with plain
    leading/trailing space but not blank -- real content sits under it --
    must keep matching itself exactly, the same as before pkm-1rb5. The
    row is inserted directly (not via get_or_create_page) to simulate the
    pre-existing production page: it was minted back when refs/ops never
    stripped, so its stored title carries the padding."""
    db = _fresh_db(tmp_path)
    padded = " EvilCorp"
    db.execute(
        "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
        (padded, 100, 100))
    original = fetch_page(db, padded)
    assert original is not None

    # Same padded title again -> the SAME page, not a fresh duplicate.
    reused = get_or_create_page(db, padded, 200)
    assert reused["id"] == original["id"]
    assert reused["title"] == padded  # padding untouched in storage too

    # A stripped variant is a genuinely different title (exact match only)
    # -- it must NOT hijack the padded page's content.
    stripped = get_or_create_page(db, "EvilCorp", 300)
    assert stripped["id"] != original["id"]
    db.close()


def test_create_page_op_reuses_a_pre_existing_padded_title(
        client, seeded_config):
    """End-to-end version of the same regression through the ops API:
    posting create_page with the exact pre-existing padded title must
    reuse that page, not duplicate it."""
    padded = " Legacy Padded Page"
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
        (padded, 100, 100))
    con.commit()
    original_id = con.execute(
        "SELECT id FROM pages WHERE title = ?", (padded,)).fetchone()[0]
    con.close()

    r = _post_ops(client, {"op": "create_page", "page_title": padded})
    assert r.status_code == 200

    con = sqlite3.connect(seeded_config.db_path)
    rows = con.execute(
        "SELECT id FROM pages WHERE title = ?", (padded,)).fetchall()
    stripped_rows = con.execute(
        "SELECT id FROM pages WHERE title = ?", (padded.strip(),)).fetchall()
    con.close()
    assert rows == [(original_id,)]      # reused, not duplicated
    assert stripped_rows == []           # no stray stripped-title page either


def test_create_op_with_spaces_only_ref_in_text_does_not_500(
        client, seeded_config):
    """Final-review CRITICAL: refs.extract()'s own blank-ref check reuses
    the narrow normalize_title, so a spaces-only bracket ref like
    "[[   ]]" is NOT dropped there -- it reaches ReindexRefs's
    get_or_create_page(ref.title="   ", ...) unguarded, which now raises
    BlankTitleError. routes_ops only catches OpError, so this must not
    surface as an uncaught 500; the ref must simply be skipped (extract()'s
    own docstring: a title that normalizes to blank "is not a reference at
    all")."""
    r = _post_ops(client, {"op": "create", "uid": "spacesref1",
                           "page_title": "Machine Learning", "parent_uid": None,
                           "order_idx": 5, "text": "hello [[   ]] world"})
    assert r.status_code == 200
    assert _blank_titles(seeded_config) == []
    con = sqlite3.connect(seeded_config.db_path)
    ref_count = con.execute(
        "SELECT count(*) FROM refs WHERE src_block_uid = ?",
        ("spacesref1",)).fetchone()[0]
    con.close()
    assert ref_count == 0  # the spaces-only ref was skipped, not indexed


def test_rename_page_with_referencing_spaces_only_ref_succeeds(
        client, seeded_config):
    """Final-review CRITICAL: rename_page_rows -> rewrite_referencing_blocks
    hits the exact same unguarded get_or_create_page(ref.title) call, for
    every block referencing the page being renamed, that ReindexRefs does.
    uid_b4 already refs "Machine Learning" (page id 1, SEED_REFS); adding a
    spaces-only "[[   ]]" ref to its text must not turn an ordinary rename
    into a 500 -- the rename route only catches sqlite3.IntegrityError."""
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "UPDATE blocks SET text = ? WHERE uid = ?",
        ("Studying [[Machine Learning]] today, see also [[   ]]", "uid_b4"))
    con.commit()
    con.close()

    r = client.post("/api/page/Machine Learning/rename",
                    json={"new_title": "ML Renamed", "allow_merge": False})
    assert r.status_code == 200
    assert r.json() == {"result": "renamed", "title": "ML Renamed"}
    assert _blank_titles(seeded_config) == []
