# Title Editing / Page Merging (pkm-g0t5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click-to-edit page titles: rename a page (rewriting every `[[ ]]`/`#tag`/`attr::` reference in block text) or, when the new title collides with an existing page, merge the two pages by concatenation after a confirm.

**Architecture:** One atomic server endpoint `POST /api/page/{title}/rename` (mirrors page delete: single transaction, journal triggers capture all row changes, one WS nudge propagates to every client). Pure text-rewrite logic lives in a new Functional Core module `pkm/rename.py`; the imperative work (row updates, block moves) lives in `store.py` helpers. The web client swaps the static `<h1>` for a click-to-edit `PageTitle` component that drives the 409→confirm→`allow_merge` retry flow.

**Tech Stack:** FastAPI + SQLite (server), React + TypeScript + vitest + Playwright (web).

**Spec:** `docs/superpowers/specs/2026-07-17-title-rename-merge-design.md`

## Global Constraints

- Work on branch `feat/title-rename-merge` in a git worktree; run every command from the worktree root. Check `git status -sb` before EVERY commit (parallel sessions can switch a shared checkout's branch).
- Every new file with runtime behaviour declares `# pattern: Functional Core` or `# pattern: Imperative Shell` (TS: `// pattern: ...`) near the top.
- After any server route change, regenerate the API contract and commit both files in the same commit: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`, then `cd web && pnpm gen-types` (else `test_openapi_sync.py` fails).
- Verification commands: `cd server && uv run pytest -q` (enforced coverage), `cd server && uv run pyrefly check`, `cd server && uv run ruff check`, `cd web && pnpm verify` (typecheck + unit coverage + Playwright E2E; E2E serves `web/dist`, so it builds first).
- Always `git push` after committing.
- Never start dev/test servers on port 8974 (prod launchd service owns it). E2E manages its own port.
- All title comparisons are case-sensitive, matching `pages.title`'s binary-collation UNIQUE constraint.
- Update bean `.beans/pkm-g0t5--title-editingpage-merging.md` status/checklist as tasks complete and commit it with code changes (`beans update pkm-g0t5 --status in-progress` at start).

---

### Task 1: Functional Core — `rewrite_title_refs`

**Files:**
- Create: `server/src/pkm/rename.py`
- Test: `server/tests/test_rename.py`

**Interfaces:**
- Consumes: `pkm.refs._ATTRIBUTE`, `pkm.refs._HASHTAG`, `pkm.refs._strip_code` (existing grammar, pinned by `shared/fixtures/ref_grammar.json`).
- Produces: `rewrite_title_refs(text: str, old_title: str, new_title: str) -> str` — used by Task 2's store helpers.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_rename.py
from pkm.rename import rewrite_title_refs


def test_link_rewritten():
    assert rewrite_title_refs("see [[Old]] now", "Old", "New") == \
        "see [[New]] now"


def test_multiple_occurrences_rewritten():
    assert rewrite_title_refs("[[Old]] and [[Old]]", "Old", "New") == \
        "[[New]] and [[New]]"


def test_other_titles_untouched():
    assert rewrite_title_refs("[[Older]] then [[Old]]", "Old", "New") == \
        "[[Older]] then [[New]]"


def test_case_sensitive():
    assert rewrite_title_refs("[[old]] stays", "Old", "New") == "[[old]] stays"


def test_bracket_tag_keeps_form():
    assert rewrite_title_refs("x #[[Old]] y", "Old", "New") == "x #[[New]] y"


def test_bare_tag_keeps_form():
    assert rewrite_title_refs("x #Old y", "Old", "New") == "x #New y"


def test_bare_tag_downgrades_when_new_title_has_spaces():
    assert rewrite_title_refs("x #Old y", "Old", "New Name") == \
        "x #[[New Name]] y"


def test_bare_tag_prefix_not_rewritten():
    # #Oldish is a different tag
    assert rewrite_title_refs("x #Oldish y", "Old", "New") == "x #Oldish y"


def test_attribute_keeps_form():
    assert rewrite_title_refs("Old:: some value", "Old", "New") == \
        "New:: some value"


def test_attribute_downgrades_when_new_title_breaks_grammar():
    # ':' can't appear in an attribute name -> downgrade to a link
    assert rewrite_title_refs("Old:: some value", "Old", "Re: New") == \
        "[[Re: New]] some value"


def test_attribute_only_at_line_start():
    # mid-text "Old::" is not an attribute (grammar anchors at start)
    assert rewrite_title_refs("see Old:: here", "Old", "New") == \
        "see Old:: here"


def test_code_fence_untouched():
    text = "```\n[[Old]]\n``` and [[Old]]"
    assert rewrite_title_refs(text, "Old", "New") == \
        "```\n[[Old]]\n``` and [[New]]"


def test_inline_code_untouched():
    assert rewrite_title_refs("`[[Old]]` and [[Old]]", "Old", "New") == \
        "`[[Old]]` and [[New]]"


def test_nested_link_inner_rewritten():
    # renaming the inner page mutates the outer title text too — documented
    # consequence of Roam's nesting (the inner ref must follow the rename)
    assert rewrite_title_refs("[[A [[Old]]]]", "Old", "New") == "[[A [[New]]]]"


def test_nested_link_outer_rewritten():
    assert rewrite_title_refs("[[A [[B]]]]", "A [[B]]", "C [[B]]") == \
        "[[C [[B]]]]"


def test_no_refs_no_change():
    assert rewrite_title_refs("plain text", "Old", "New") == "plain text"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_rename.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.rename'`

- [ ] **Step 3: Write the implementation**

```python
# server/src/pkm/rename.py
# pattern: Functional Core
"""Rewrite title references in block text for a page rename (pkm-g0t5).

Locates spans with the same grammar refs.extract() uses (pinned by
shared/fixtures/ref_grammar.json): [[Title]], #[[Title]], #Title, and a
leading Title:: attribute. Code spans are never rewritten. Forms are
preserved where the new title still parses in that form and downgraded
otherwise (#tag -> #[[..]], attribute -> [[..]])."""
from __future__ import annotations

import re

from pkm.refs import _ATTRIBUTE, _HASHTAG, _strip_code

_BARE_TAG = re.compile(r"[\w/.\-]+")  # _HASHTAG's capture class


def _tag_form(new_title: str) -> str:
    if _BARE_TAG.fullmatch(new_title):
        return f"#{new_title}"
    return f"#[[{new_title}]]"


def _attribute_form(new_title: str) -> str:
    m = _ATTRIBUTE.match(f"{new_title}::")
    if m is not None and m.group(1).strip() == new_title:
        return f"{new_title}::"
    return f"[[{new_title}]]"


def rewrite_title_refs(text: str, old_title: str, new_title: str) -> str:
    """Return `text` with every ref to `old_title` retargeted at `new_title`.

    Spans are located on the code-stripped shadow of the text (positions
    line up: _strip_code substitutes spaces 1:1), then spliced into the
    original right-to-left so earlier offsets stay valid."""
    clean = _strip_code(text)
    spans: list[tuple[int, int, str]] = []  # (start, end, replacement)

    if (m := _ATTRIBUTE.match(clean)) and m.group(1).strip() == old_title:
        spans.append((m.start(1), m.end(), _attribute_form(new_title)))

    needle = f"[[{old_title}]]"
    i = clean.find(needle)
    while i != -1:
        spans.append((i, i + len(needle), f"[[{new_title}]]"))
        i = clean.find(needle, i + len(needle))

    for m in _HASHTAG.finditer(clean):
        if m.group(1) == old_title:
            spans.append((m.start(), m.end(), _tag_form(new_title)))

    out = text
    for start, end, repl in sorted(spans, reverse=True):
        out = out[:start] + repl + out[end:]
    return out
```

Why the forms can't collide: an attribute name can't contain brackets (its
char class excludes them) and only matches at the start of the text; a bare
hashtag's class excludes `[`, so `#[[..]]` never matches `_HASHTAG`; bracket
needles are literal balanced spans. The three scans therefore produce
disjoint spans and right-to-left splicing is safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_rename.py tests/test_refs.py -q`
Expected: all PASS

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd server && uv run ruff check && uv run pyrefly check
git status -sb   # confirm branch feat/title-rename-merge
git add server/src/pkm/rename.py server/tests/test_rename.py
git commit -m "Add title-ref rewrite core for page rename (pkm-g0t5)"
git push
```

---

### Task 2: Rename endpoint (no-collision path) + contract regen

**Files:**
- Modify: `server/src/pkm/server/store.py` (append helpers after `delete_page_rows`)
- Modify: `server/src/pkm/server/routes_pages.py` (request model near `CreatePageRequest` at line 32; route after `delete_page` at line 178)
- Modify (regenerated): `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Test: `server/tests/test_rename_endpoint.py`

**Interfaces:**
- Consumes: `rewrite_title_refs(text, old_title, new_title) -> str` (Task 1); existing `fetch_page`, `get_or_create_page`, `date_for_title`, `notify.nudge_threadpool`.
- Produces:
  - `rename_page_rows(db, page_id: int, old_title: str, new_title: str, now_ms: int) -> None`
  - `rewrite_referencing_blocks(db, page_id: int, old_title: str, new_title: str, now_ms: int) -> None`
  - `retitle_sidebar_entry(db, old_title: str, new_title: str) -> None`
  - Route `POST /api/page/{title:path}/rename`, body `{"new_title": str, "allow_merge": bool}` → `{"result": "renamed", "title": str}` (Task 3 adds `"merged"`).

Seeded fixture facts used below (see `server/tests/conftest.py`): page 1 = "Machine Learning" (blocks `uid_b1` "Tags:: #AI", `uid_b2` "Papers", child `uid_b3`), page 2 = "AI", page 3 = "July 7th, 2026" (block `uid_b4` "Studying [[Machine Learning]] today"), refs include `(uid_b4, 1, link)` and `(uid_b1, 2, tag)`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_rename_endpoint.py
import sqlite3


def _rename(client, title, new_title, allow_merge=False):
    return client.post(f"/api/page/{title}/rename",
                       json={"new_title": new_title,
                             "allow_merge": allow_merge})


def test_rename_updates_title_and_referencing_text(client):
    r = _rename(client, "Machine Learning", "ML Stuff")
    assert r.status_code == 200
    assert r.json() == {"result": "renamed", "title": "ML Stuff"}

    assert client.get("/api/page/Machine Learning").status_code == 404
    body = client.get("/api/page/ML Stuff").json()
    assert [b["text"] for b in body["blocks"]] == ["Tags:: #AI", "Papers"]

    # the daily page's [[link]] text followed the rename
    daily = client.get("/api/page/July 7th, 2026").json()
    assert "Studying [[ML Stuff]] today" in [b["text"] for b in daily["blocks"]]


def test_rename_keeps_backlinks(client, seeded_config):
    _rename(client, "Machine Learning", "ML Stuff")
    con = sqlite3.connect(seeded_config.db_path)
    refs = con.execute(
        "SELECT src_block_uid, kind FROM refs WHERE target_page_id = 1"
    ).fetchall()
    con.close()
    assert ("uid_b4", "link") in refs
    body = client.get("/api/page/ML Stuff").json()
    assert body["backlinks"]["total_pages"] == 1


def test_rename_does_not_recreate_old_page(client):
    _rename(client, "Machine Learning", "ML Stuff")
    # rewriting must not leave any block text resolving to the old title
    assert client.get("/api/page/Machine Learning").status_code == 404


def test_rename_updates_search_index(client):
    _rename(client, "Machine Learning", "Deep Learning Notes")
    pages = client.get("/api/search?q=Deep Learning Notes").json()["pages"]
    assert any(p["title"] == "Deep Learning Notes" for p in pages)


def test_rename_retitles_sidebar_entry(client):
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    entry_id = add.json()["id"]
    _rename(client, "Machine Learning", "ML Stuff")
    entries = client.get("/api/sidebar").json()["entries"]
    assert any(e["id"] == entry_id and e["title"] == "ML Stuff"
               for e in entries)


def test_rename_case_fix_is_plain_rename(client):
    r = _rename(client, "AI", "ai")
    assert r.status_code == 200
    assert r.json()["result"] == "renamed"
    assert client.get("/api/page/ai").status_code == 200


def test_rename_missing_page_404(client):
    assert _rename(client, "No Such Page", "X").status_code == 404


def test_rename_unchanged_title_400(client):
    assert _rename(client, "AI", "AI").status_code == 400


def test_rename_blank_title_422(client):
    assert _rename(client, "AI", "   ").status_code == 422


def test_rename_daily_note_source_400(client):
    r = _rename(client, "July 7th, 2026", "Old Diary")
    assert r.status_code == 400
    assert "daily" in r.json()["detail"]


def test_rename_to_date_shaped_title_allowed(client):
    r = _rename(client, "AI", "March 3rd, 2031")
    assert r.status_code == 200
    assert client.get("/api/page/March 3rd, 2031").status_code == 200


def test_rename_requires_auth(anon_client):
    r = anon_client.post("/api/page/AI/rename",
                         json={"new_title": "X", "allow_merge": False})
    assert r.status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_rename_endpoint.py -q`
Expected: FAIL — every test 404s/405s (route does not exist yet)

- [ ] **Step 3: Add the store helpers**

Append to `server/src/pkm/server/store.py` (and add the two imports at the top, after `import sqlite3`):

```python
from pkm.refs import extract
from pkm.rename import rewrite_title_refs
```

```python
def rewrite_referencing_blocks(db: sqlite3.Connection, page_id: int,
                               old_title: str, new_title: str,
                               now_ms: int) -> None:
    """Rewrite [[old]]/#old/old:: in every block that refs `page_id`, then
    reindex those blocks' refs from the rewritten text. Must run AFTER the
    new title exists in pages (rename applied / merge target present) so
    the reindex resolves [[new]] to the surviving row instead of creating
    a page. Never commits."""
    rows = db.execute(
        """SELECT DISTINCT b.uid, b.text FROM refs r
             JOIN blocks b ON b.uid = r.src_block_uid
            WHERE r.target_page_id = ?""", (page_id,)).fetchall()
    for row in rows:
        new_text = rewrite_title_refs(row["text"], old_title, new_title)
        if new_text != row["text"]:
            db.execute(
                "UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
                (new_text, now_ms, row["uid"]))
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (row["uid"],))
        for ref in extract(new_text).refs:
            page = get_or_create_page(db, ref.title, now_ms)
            db.execute("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
                       (row["uid"], page["id"], ref.kind))


def retitle_sidebar_entry(db: sqlite3.Connection, old_title: str,
                          new_title: str) -> None:
    """Follow a rename/merge in the title-keyed sidebar table. If an entry
    already exists under the new title (merge target pinned, or an orphan),
    the old entry is dropped instead of violating UNIQUE(title)."""
    if db.execute("SELECT 1 FROM sidebar_entries WHERE title = ?",
                  (new_title,)).fetchone() is not None:
        db.execute("DELETE FROM sidebar_entries WHERE title = ?",
                   (old_title,))
    else:
        db.execute("UPDATE sidebar_entries SET title = ? WHERE title = ?",
                   (new_title, old_title))


def rename_page_rows(db: sqlite3.Connection, page_id: int, old_title: str,
                     new_title: str, now_ms: int) -> None:
    """Rename in place. Refs stay valid (keyed by page id); pages_fts is
    trigger-maintained. Never commits."""
    db.execute("UPDATE pages SET title = ?, updated_at = ? WHERE id = ?",
               (new_title, now_ms, page_id))
    rewrite_referencing_blocks(db, page_id, old_title, new_title, now_ms)
    retitle_sidebar_entry(db, old_title, new_title)
```

- [ ] **Step 4: Add the route**

In `server/src/pkm/server/routes_pages.py`, extend the store import (line 23) to:

```python
from pkm.server.store import (delete_page_rows, fetch_page,
                              get_or_create_page, rename_page_rows)
```

Add below `CreatePageRequest` (line 34):

```python
class RenamePageRequest(BaseModel):
    new_title: str = Field(min_length=1)
    allow_merge: bool = False
```

Add after `delete_page` (line 178):

```python
@router.post("/api/page/{title:path}/rename")
def rename_page(request: Request, title: str, body: RenamePageRequest,
                db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Rename a page, rewriting every [[link]]/#tag/attr:: in block text.
    409 when the new title is taken and allow_merge is false; Task 3 wires
    the merge. Case-sensitive throughout, like pages.title itself."""
    new_title = body.new_title.strip()
    if not new_title:
        raise HTTPException(status_code=422,
                            detail="title must not be blank")
    page = fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    if new_title == title:
        raise HTTPException(status_code=400, detail="title is unchanged")
    if date_for_title(title) is not None:
        raise HTTPException(status_code=400,
                            detail="daily notes cannot be renamed")
    target = fetch_page(db, new_title)
    if target is not None:
        raise HTTPException(status_code=409,
                            detail=f"page {new_title!r} already exists")
    rename_page_rows(db, page["id"], title, new_title,
                     int(time.time() * 1000))
    db.commit()
    notify.nudge_threadpool(request, db)
    return {"result": "renamed", "title": new_title}
```

Route-matching note: FastAPI registers this alongside `GET/DELETE
/api/page/{title:path}`; methods differ, and Starlette falls through partial
(method-mismatch) matches, so no conflict. The greedy `{title:path}` still
matches titles containing `/` (namespace pages) because the trailing literal
`/rename` anchors the regex.

- [ ] **Step 5: Run tests**

Run: `cd server && uv run pytest tests/test_rename_endpoint.py -q`
Expected: all PASS

- [ ] **Step 6: Regenerate the API contract**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

Run: `cd server && uv run pytest tests/test_openapi_sync.py -q`
Expected: PASS

- [ ] **Step 7: Full server suite, lint, typecheck, commit**

```bash
cd server && uv run pytest -q && uv run ruff check && uv run pyrefly check
git status -sb
git add server/src/pkm/server/store.py server/src/pkm/server/routes_pages.py \
        server/tests/test_rename_endpoint.py \
        web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "Add page rename endpoint with ref rewrite (pkm-g0t5)"
git push
```

---### Task 3: Merge path

**Files:**
- Modify: `server/src/pkm/server/store.py` (append `merge_page_rows`)
- Modify: `server/src/pkm/server/routes_pages.py` (`rename_page` collision branch)
- Test: `server/tests/test_rename_endpoint.py` (append)

**Interfaces:**
- Consumes: Task 2's helpers and route.
- Produces: `merge_page_rows(db, source_id: int, target_id: int, old_title: str, new_title: str, now_ms: int) -> None`; the route now returns `{"result": "merged", "title": new_title}` when `allow_merge` is true and the title collides.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_rename_endpoint.py`:

```python
def test_rename_collision_409_changes_nothing(client):
    r = _rename(client, "AI", "Machine Learning")
    assert r.status_code == 409
    # both pages intact, text untouched
    assert client.get("/api/page/AI").status_code == 200
    ml = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in ml["blocks"]] == ["Tags:: #AI", "Papers"]


def test_merge_appends_blocks_and_rewrites_refs(client):
    r = _rename(client, "AI", "Machine Learning", allow_merge=True)
    assert r.status_code == 200
    assert r.json() == {"result": "merged", "title": "Machine Learning"}

    assert client.get("/api/page/AI").status_code == 404
    ml = client.get("/api/page/Machine Learning").json()
    texts = [b["text"] for b in ml["blocks"]]
    # target blocks first, source's top-level block appended; uid_b1's
    # "#AI" tag rewrote to the bracketed form (new title has a space)
    assert texts == ["Tags:: #[[Machine Learning]]", "Papers",
                     "AI overview mentions Machine Learning in plain text"]


def test_merge_repoints_refs_to_target(client, seeded_config):
    _rename(client, "AI", "Machine Learning", allow_merge=True)
    con = sqlite3.connect(seeded_config.db_path)
    assert con.execute(
        "SELECT count(*) FROM refs WHERE target_page_id = 2").fetchone()[0] == 0
    assert ("uid_b1",) in con.execute(
        "SELECT src_block_uid FROM refs WHERE target_page_id = 1").fetchall()
    con.close()


def test_merge_preserves_source_subtrees(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " collapsed) VALUES ('uid_child', 2, 'uid_b6', 0, 'nested', 0)")
    con.commit()
    con.close()
    _rename(client, "AI", "Machine Learning", allow_merge=True)
    ml = client.get("/api/page/Machine Learning").json()
    appended = ml["blocks"][2]
    assert appended["text"].startswith("AI overview")
    assert [c["text"] for c in appended["children"]] == ["nested"]


def test_merge_case_variants(client):
    client.post("/api/pages", json={"title": "cLaude"})
    client.post("/api/pages", json={"title": "Claude"})
    r = _rename(client, "cLaude", "Claude")
    assert r.status_code == 409
    r = _rename(client, "cLaude", "Claude", allow_merge=True)
    assert r.status_code == 200 and r.json()["result"] == "merged"
    assert client.get("/api/page/cLaude").status_code == 404


def test_merge_block_with_both_titles_dedupes_refs(client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.executescript("""
        INSERT INTO pages(id, title) VALUES (60, 'cLaude'), (61, 'Claude');
        INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,
                           collapsed)
        VALUES ('uid_both', 4, NULL, 1, '[[cLaude]] vs [[Claude]]', 0);
        INSERT INTO refs VALUES ('uid_both', 60, 'link'),
                                ('uid_both', 61, 'link');
    """)
    con.commit()
    con.close()
    _rename(client, "cLaude", "Claude", allow_merge=True)
    con = sqlite3.connect(seeded_config.db_path)
    text = con.execute("SELECT text FROM blocks WHERE uid = 'uid_both'"
                       ).fetchone()[0]
    refs = con.execute("SELECT target_page_id, kind FROM refs"
                       " WHERE src_block_uid = 'uid_both'").fetchall()
    con.close()
    assert text == "[[Claude]] vs [[Claude]]"
    assert refs == [(61, "link")]


def test_merge_sidebar_both_pinned_keeps_target_entry(client):
    client.post("/api/sidebar", json={"title": "AI"})
    add = client.post("/api/sidebar", json={"title": "Machine Learning"})
    target_entry = add.json()["id"]
    _rename(client, "AI", "Machine Learning", allow_merge=True)
    entries = client.get("/api/sidebar").json()["entries"]
    titles = [e["title"] for e in entries]
    assert titles.count("Machine Learning") == 1
    assert any(e["id"] == target_entry for e in entries)


def test_allow_merge_without_collision_is_plain_rename(client):
    r = _rename(client, "AI", "Fresh Title", allow_merge=True)
    assert r.status_code == 200
    assert r.json()["result"] == "renamed"
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd server && uv run pytest tests/test_rename_endpoint.py -q`
Expected: the Task 3 tests FAIL on 409 (merge branch missing); Task 2 tests still PASS

- [ ] **Step 3: Add `merge_page_rows`**

Append to `server/src/pkm/server/store.py`:

```python
def merge_page_rows(db: sqlite3.Connection, source_id: int, target_id: int,
                    old_title: str, new_title: str, now_ms: int) -> None:
    """Concatenate source onto target: rewrite/reindex referencing text
    first (so [[new]] resolves to the target), append the source's
    top-level blocks after the target's (subtrees follow via parent_uid;
    uids never change, so ((uid)) block refs keep resolving), then drop
    the source page row. Never commits."""
    rewrite_referencing_blocks(db, source_id, old_title, new_title, now_ms)
    base = db.execute(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM blocks"
        " WHERE page_id = ? AND parent_uid IS NULL",
        (target_id,)).fetchone()[0]
    tops = db.execute(
        "SELECT uid FROM blocks WHERE page_id = ? AND parent_uid IS NULL"
        " ORDER BY order_idx", (source_id,)).fetchall()
    for i, row in enumerate(tops):
        db.execute(
            "UPDATE blocks SET page_id = ?, order_idx = ?, updated_at = ?"
            " WHERE uid = ?", (target_id, base + i, now_ms, row["uid"]))
    db.execute(  # descendants: same page, original order_idx
        "UPDATE blocks SET page_id = ?, updated_at = ? WHERE page_id = ?",
        (target_id, now_ms, source_id))
    db.execute("UPDATE pages SET updated_at = ? WHERE id = ?",
               (now_ms, target_id))
    db.execute("DELETE FROM pages WHERE id = ?", (source_id,))
    retitle_sidebar_entry(db, old_title, new_title)
```

- [ ] **Step 4: Wire the route's merge branch**

In `rename_page` in `routes_pages.py`, replace the collision guard added in Task 2:

```python
    target = fetch_page(db, new_title)
    if target is not None:
        raise HTTPException(status_code=409,
                            detail=f"page {new_title!r} already exists")
    rename_page_rows(db, page["id"], title, new_title,
                     int(time.time() * 1000))
    db.commit()
    notify.nudge_threadpool(request, db)
    return {"result": "renamed", "title": new_title}
```

with:

```python
    now_ms = int(time.time() * 1000)
    target = fetch_page(db, new_title)
    if target is None:
        rename_page_rows(db, page["id"], title, new_title, now_ms)
        result = "renamed"
    elif not body.allow_merge:
        raise HTTPException(status_code=409,
                            detail=f"page {new_title!r} already exists")
    else:
        merge_page_rows(db, page["id"], target["id"], title, new_title,
                        now_ms)
        result = "merged"
    db.commit()
    notify.nudge_threadpool(request, db)
    return {"result": result, "title": new_title}
```

and extend the store import to include `merge_page_rows`. Update the route
docstring's "Task 3 wires the merge" sentence to describe the merge
(concatenation, confirm-gated by allow_merge).

- [ ] **Step 5: Run the full server suite, lint, typecheck**

Run: `cd server && uv run pytest -q && uv run ruff check && uv run pyrefly check`
Expected: all PASS (openapi unchanged — same route/shape, so no regen needed)

- [ ] **Step 6: Commit**

```bash
git status -sb
git add server/src/pkm/server/store.py server/src/pkm/server/routes_pages.py \
        server/tests/test_rename_endpoint.py
git commit -m "Add page merge-by-concatenation to rename endpoint (pkm-g0t5)"
git push
```

---

### Task 4: Web — click-to-edit `PageTitle`

**Files:**
- Create: `web/src/components/PageTitle.tsx`
- Modify: `web/src/views/PageView.tsx:137` (replace the `<h1>`)
- Modify: `web/src/styles.css` (after `.page-title a` rule, line 248)
- Test: `web/src/components/PageTitle.test.tsx`

**Interfaces:**
- Consumes: `POST /api/page/{title}/rename` (Tasks 2–3); `apiFetch`/`ApiError` (`web/src/api/client.ts`); `dateForTitle` (`web/src/replica/daily.ts`); `pagePath`, `encodeTitle` (`web/src/paths.ts`).
- Produces: `PageTitle({ title }: { title: string })` component.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/PageTitle.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../api/client";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { PageTitle } from "./PageTitle";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});
const apiFetchMock = vi.mocked(apiFetch);

function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname}</p>;
}

function mount(title: string) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/x"]}>
      <PageTitle title={title} />
      <Probe />
    </MemoryRouter>);
}

function startEditing(title: string) {
  fireEvent.click(screen.getByRole("heading", { name: title }));
  return screen.getByRole("textbox") as HTMLInputElement;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

it("renders the title as a heading", () => {
  mount("My Page");
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("click swaps to an input holding the current title", () => {
  mount("My Page");
  const input = startEditing("My Page");
  expect(input.value).toBe("My Page");
});

it("Enter commits a rename and navigates to the new page", async () => {
  apiFetchMock.mockResolvedValue({ result: "renamed", title: "New Name" });
  mount("My Page");
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "New Name" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(screen.getByTestId("loc")).toHaveTextContent("/page/New%20Name"));
  expect(apiFetchMock).toHaveBeenCalledWith("/api/page/My%20Page/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_title: "New Name", allow_merge: false }),
  });
});

it("Escape reverts without calling the API", () => {
  mount("My Page");
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "Changed" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);
  expect(apiFetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("unchanged or blank titles commit as a no-op", () => {
  mount("My Page");
  fireEvent.blur(startEditing("My Page"));
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.blur(input);
  expect(apiFetchMock).not.toHaveBeenCalled();
});

it("409 asks to merge and retries with allow_merge", async () => {
  apiFetchMock
    .mockRejectedValueOnce(new ApiError(409, "/api/page/My%20Page/rename"))
    .mockResolvedValueOnce({ result: "merged", title: "Existing" });
  mount("My Page");
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "Existing" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(screen.getByTestId("loc")).toHaveTextContent("/page/Existing"));
  expect(window.confirm).toHaveBeenCalledWith(
    'Page "Existing" already exists — merge this page into it?');
  expect(apiFetchMock).toHaveBeenLastCalledWith(
    "/api/page/My%20Page/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_title: "Existing", allow_merge: true }),
    });
});

it("declining the merge confirm leaves everything alone", async () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  apiFetchMock.mockRejectedValue(new ApiError(409, "x"));
  mount("My Page");
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "Existing" } });
  fireEvent.blur(input);
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/x");
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("other errors revert and surface a message", async () => {
  apiFetchMock.mockRejectedValue(new ApiError(500, "x"));
  mount("My Page");
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "New Name" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(screen.getByText(/request failed: 500/)).toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("daily-note titles are not editable", () => {
  mount("July 17th, 2026");
  fireEvent.click(screen.getByRole("heading", { name: "July 17th, 2026" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit -- PageTitle`
Expected: FAIL — cannot resolve `./PageTitle`

- [ ] **Step 3: Implement the component**

```tsx
// web/src/components/PageTitle.tsx
// pattern: Imperative Shell
// Click-to-edit page title (pkm-g0t5). Enter/blur commit, Escape reverts.
// A commit POSTs /rename with allow_merge=false; a 409 means the title is
// taken, so ask (same window.confirm pattern as Delete page) and retry
// with allow_merge=true. Daily notes are not editable (server rejects
// them too). The server is atomic, so any failure = clean revert.
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import { encodeTitle, pagePath } from "../paths";
import { dateForTitle } from "../replica/daily";

interface RenameResult {
  result: "renamed" | "merged";
  title: string;
}

export function PageTitle({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const navigate = useNavigate();
  const editable = dateForTitle(title) === null;

  const rename = (newTitle: string, allowMerge: boolean) =>
    apiFetch<RenameResult>(`/api/page/${encodeTitle(title)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_title: newTitle, allow_merge: allowMerge }),
    });

  const commit = async (value: string) => {
    setEditing(false);
    const newTitle = value.trim();
    if (!newTitle || newTitle === title) return;
    try {
      const r = await rename(newTitle, false);
      navigate(pagePath(r.title));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (!window.confirm(
          `Page "${newTitle}" already exists — merge this page into it?`)) {
          return;
        }
        try {
          const r = await rename(newTitle, true);
          navigate(pagePath(r.title));
        } catch (retryError) {
          setError(String(retryError));
        }
        return;
      }
      setError(String(e));
    }
  };

  if (!editing) {
    return (
      <>
        <h1 className={`page-title${editable ? " page-title-editable" : ""}`}
            onClick={editable ? () => {
              cancelledRef.current = false;
              setError(null);
              setEditing(true);
            } : undefined}>
          {title}
        </h1>
        {error !== null && <p className="error">{error}</p>}
      </>
    );
  }
  return (
    <input className="page-title page-title-input" defaultValue={title}
           aria-label="Page title"
           // eslint-disable-next-line jsx-a11y/no-autofocus
           autoFocus
           onKeyDown={(e) => {
             if (e.key === "Enter") {
               e.preventDefault();
               e.currentTarget.blur(); // commit runs in onBlur, exactly once
             } else if (e.key === "Escape") {
               cancelledRef.current = true;
               e.currentTarget.blur();
             }
           }}
           onBlur={(e) => {
             if (cancelledRef.current) {
               cancelledRef.current = false;
               setEditing(false);
               return;
             }
             void commit(e.currentTarget.value);
           }} />
  );
}
```

(Drop the eslint-disable line if `pnpm verify`'s lint doesn't flag
`autoFocus`; keep the attribute either way — focus-on-edit is the feature.)

- [ ] **Step 4: Wire into PageView and style**

In `web/src/views/PageView.tsx`: add `import { PageTitle } from "../components/PageTitle";` and replace line 137:

```tsx
        <h1 className="page-title">{payload.page.title}</h1>
```

with:

```tsx
        <PageTitle title={payload.page.title} />
```

In `web/src/styles.css`, after the `.page-title a` rule (line 248):

```css
.page-title-editable { cursor: text; }
.page-title-input { display: block; width: 100%; padding: 0; border: none;
  outline: none; background: transparent; color: inherit;
  font-family: inherit; }
```

(The input keeps the `page-title` class, so size/weight/margin come from the
existing rule and the swap causes no layout jump.)

- [ ] **Step 5: Run unit tests and typecheck**

Run: `cd web && pnpm test:unit -- PageTitle && pnpm typecheck`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git status -sb
git add web/src/components/PageTitle.tsx web/src/components/PageTitle.test.tsx \
        web/src/views/PageView.tsx web/src/styles.css
git commit -m "Add click-to-edit page title with merge confirm (pkm-g0t5)"
git push
```

---

### Task 5: Playwright E2E

**Files:**
- Create: `web/e2e/rename.spec.ts`

**Interfaces:**
- Consumes: the full stack from Tasks 1–4; e2e helpers `web/e2e/fixtures.ts` (`test`, `expect`), `web/e2e/server-state.ts` (`waitForServerText`).

- [ ] **Step 1: Write the spec**

Follow `web/e2e/edit.spec.ts`'s login/input helpers exactly (they encode
hard-won timing rules — `.ws-banner` wait, `waitForServerText` before
reload):

```ts
// web/e2e/rename.spec.ts
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

const caretToEnd = (page: Page) =>
  input(page).evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length));

/** Append a fresh top-level block to today's journal page (never assumes
 * an empty day: e2e specs share the DB). */
async function appendJournalBlock(page: Page, text: string) {
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();
  const startWriting = today.getByText("Click to start writing…");
  if (await startWriting.count() > 0) {
    await startWriting.click();
  } else {
    await today.locator(".block-text").first().click();
    await caretToEnd(page);
    await input(page).press("Enter");
  }
  await input(page).fill(text);
  await input(page).press("Escape"); // blur: flushes the draft op
  const title = await today.locator("h1.page-title").innerText();
  await waitForServerText(page, title, text);
}

test("rename a page updates the title, URL, and referencing text", async ({ page }) => {
  await login(page);
  await appendJournalBlock(page, "marker-g0t5 [[Rename Src g0t5]]");

  await page.getByRole("link", { name: "Rename Src g0t5" }).click();
  await expect(page).toHaveURL(/\/page\/Rename%20Src%20g0t5/);

  await page.locator("h1.page-title").click();
  await page.locator("input.page-title-input").fill("Rename Dst g0t5");
  await page.locator("input.page-title-input").press("Enter");

  await expect(page).toHaveURL(/\/page\/Rename%20Dst%20g0t5/);
  await expect(page.locator("h1.page-title")).toHaveText("Rename Dst g0t5");

  // the journal block's [[link]] text was rewritten server-side
  await page.goto("/");
  await expect(page.locator(".journal-day").first())
    .toContainText("marker-g0t5 [[Rename Dst g0t5]]".replace(/\[\[|\]\]/g, ""));
  await expect(page.getByRole("link", { name: "Rename Dst g0t5" })).toBeVisible();
});

test("renaming onto an existing page merges after confirm", async ({ page }) => {
  await login(page);
  await appendJournalBlock(page, "merge-links-g0t5 [[Merge A g0t5]] [[Merge B g0t5]]");

  // put distinguishable content on the source page
  await page.getByRole("link", { name: "Merge A g0t5" }).click();
  await page.getByText("Click to start writing…").click();
  await input(page).fill("content-from-a-g0t5");
  await input(page).press("Escape");
  await waitForServerText(page, "Merge A g0t5", "content-from-a-g0t5");

  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator("h1.page-title").click();
  await page.locator("input.page-title-input").fill("Merge B g0t5");
  await page.locator("input.page-title-input").press("Enter");

  // landed on the merged page, source content appended
  await expect(page).toHaveURL(/\/page\/Merge%20B%20g0t5/);
  await expect(page.locator(".page")).toContainText("content-from-a-g0t5");

  // the source page is gone: its link in the journal now points at B
  await page.goto("/");
  const day = page.locator(".journal-day").first();
  await expect(day.locator(".block-text", { hasText: "merge-links-g0t5" })
    .getByRole("link", { name: "Merge B g0t5" })).toHaveCount(2);
});
```

- [ ] **Step 2: Run the new spec**

Run: `cd web && pnpm build && pnpm exec playwright test e2e/rename.spec.ts`
Expected: both tests PASS. If a locator doesn't match the real DOM (e.g. the
journal renders links without the `[[ ]]` brackets — it does, hence the
`.replace()` in test 1), fix the assertion to match observed reality, not
the implementation.

- [ ] **Step 3: Full web verification**

Run: `cd web && pnpm verify`
Expected: typecheck, lint, unit coverage, and the whole E2E suite PASS

- [ ] **Step 4: Commit**

```bash
git status -sb
git add web/e2e/rename.spec.ts
git commit -m "Add rename/merge E2E coverage (pkm-g0t5)"
git push
```

---

### Task 6: Final verification, bean, and merge

**Files:**
- Modify: `.beans/pkm-g0t5--title-editingpage-merging.md` (via `beans update`)

- [ ] **Step 1: Run everything from the worktree root**

```bash
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
cd ../web && pnpm verify
```

Expected: all PASS. Do not proceed on any failure — fix first
(superpowers:verification-before-completion).

- [ ] **Step 2: Complete the bean**

```bash
beans update pkm-g0t5 --status completed
git add .beans && git commit -m "chore(beans): mark pkm-g0t5 completed" && git push
```

- [ ] **Step 3: Finish the branch**

Use superpowers:finishing-a-development-branch. On merge:
`git merge --no-ff feat/title-rename-merge` (repo rule), then push main.
Do NOT deploy to prod unless the user asks (deploys run
`~/.config/pkm/app/deploy/update.sh`, never the dev checkout's copy).
