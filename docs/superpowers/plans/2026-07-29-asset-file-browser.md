# Asset File Browser (pkm-jdu3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/files` page for browsing, filtering, exporting, and deleting uploaded assets, with an orphan-cleanup workflow and a retro-scan trigger.

**Architecture:** Server-side filtering/pagination on the existing `GET /api/assets/search`, plus two new routes: `DELETE /api/assets/{sha256}` (strips reference tokens from block text, deletes emptied leaf blocks, removes the row + disk file) and `POST /api/assets/export.zip` (form-POST, in-RAM zip of selected shas). The web side adds a `Files` view (thumbnail grid + filter bar + multi-select toolbar) backed by a functional-core `filesCore.ts`. Spec: `docs/superpowers/specs/2026-07-29-asset-file-browser-design.md`.

**Tech Stack:** FastAPI + sqlite3 (server), React 18 + vitest + Playwright (web), openapi-typescript for generated types.

## Global Constraints

- Work in a branch/worktree (created at execution time via superpowers:using-git-worktrees). Run everything from the worktree root; check `git status -sb` before EVERY commit (parallel sessions can switch the shared checkout's branch).
- Every runtime file declares `# pattern: Functional Core` / `# pattern: Imperative Shell` (server) or `// pattern: …` as the FIRST comment (web; enforced by `tooling/fcis.mjs` via `pnpm verify`).
- Server coverage is enforced: `--cov-fail-under=95` (branch). Web coverage thresholds: statements 95, branches 91, functions 89, lines 95 (`web/vite.config.ts:117`).
- Any change to server route signatures/response models requires regenerating BOTH `web/src/api/openapi.json` and `web/src/api/types.d.ts` and committing them (drift-guarded by `server/tests/test_openapi_sync.py`):
  `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`
- Store-style helpers never commit; the route owns the transaction, commits once, then calls `notify.nudge_threadpool(request, db)` strictly AFTER commit.
- Delete blocks with explicit `DELETE FROM blocks WHERE uid = ?` — never rely on FK cascade (cascade does not reliably fire the `blocks_fts_ad` FTS trigger).
- `blocks` has NO seq/LWW columns. Sync rides the server-only `changes` journal, appended automatically by `blocks_chg_ai/au/ad` triggers on every block INSERT/UPDATE/DELETE. Never bump anything manually; set `updated_at` (wall-clock ms) yourself on UPDATEs — there is no DB default.
- Update the bean `.beans/pkm-jdu3--file-browser-ui-for-asset-management.md` checklist as tasks complete; commit the bean file with the relevant code commit.
- E2E tests must NOT write to today's journal (other specs assume it's empty). Use uniquely-named POST-created pages.
- Web e2e imports `{ test, expect }` from `./fixtures` (never `@playwright/test`) — the fixture fails tests on any HTTP 5xx.

## File Structure

| File | Responsibility |
|---|---|
| `server/src/pkm/assets_core.py` (new, FC) | Pure helpers: token stripping, mime→category, category→SQL, zip arcname dedupe |
| `server/src/pkm/server/routes_assets.py` (modify) | Extended search route; new DELETE and export.zip routes |
| `server/src/pkm/server/response_models.py` (modify) | `AssetSearchItem` gains `describe_error`; `AssetSearchPayload` gains `total` |
| `server/tests/test_assets_core.py` (new) | Unit tests for assets_core |
| `server/tests/test_asset_search_filters.py` (new) | Filter/pagination tests |
| `server/tests/test_asset_delete.py` (new) | DELETE route tests |
| `server/tests/test_asset_export.py` (new) | export.zip tests |
| `server/tests/test_cli_render.py` (modify) | Strengthen missing-refs render test (pkm-t5pu carry-over) |
| `web/src/api/payloads.ts` (modify) | Re-export generated Asset types |
| `web/src/views/filesCore.ts` (new, FC) | Filters→querystring, mime category, clipboard token, confirm copy, batch summary, size formatting |
| `web/src/views/filesCore.test.ts` (new) | Unit tests for filesCore |
| `web/src/views/Files.tsx` (new, IS) | The /files view: grid, filters, selection, delete/export/scan |
| `web/src/views/Files.test.tsx` (new) | View unit tests |
| `web/src/App.tsx` (modify) | Nav link + route |
| `web/src/App.test.tsx` (modify) | /files route renders |
| `web/src/styles.css` (modify, append) | `.files-*` styles |
| `web/e2e/files.spec.ts` (new) | End-to-end browse/delete/export flow |

---

### Task 1: Server functional core — `assets_core.py`

**Files:**
- Create: `server/src/pkm/assets_core.py`
- Test: `server/tests/test_assets_core.py`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 2–4):
  - `strip_asset_tokens(text: str, sha256: str) -> str`
  - `mime_category(mime: str) -> str` (returns `"image" | "pdf" | "document" | "other"`)
  - `type_where(category: str) -> tuple[str, list[str]]` (SQL fragment + params)
  - `zip_arcnames(entries: list[tuple[str, str]]) -> list[tuple[str, str]]` ((sha, filename) → (sha, arcname))

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_assets_core.py`:

```python
"""Pure asset-browser helpers (pkm-jdu3)."""
import pytest

from pkm.assets_core import (
    mime_category, strip_asset_tokens, type_where, zip_arcnames)

SHA = "ab" * 32
URL = f"/assets/{SHA}/pic.png"


# --- strip_asset_tokens ---

def test_strips_image_token():
    assert strip_asset_tokens(f"diagram: ![alt]({URL})", SHA) == "diagram:"


def test_strips_link_token():
    assert (strip_asset_tokens(f"see [notes]({URL}) here", SHA)
            == "see here")


def test_strips_pdf_macro():
    assert strip_asset_tokens(f"{{{{[[pdf]]: {URL}}}}}", SHA) == ""


def test_strips_bare_url():
    assert strip_asset_tokens(f"raw {URL} link", SHA) == "raw link"


def test_strips_multiple_tokens_of_same_asset():
    text = f"![a]({URL}) and [b]({URL})"
    assert strip_asset_tokens(text, SHA) == "and"


def test_leaves_other_assets_alone():
    other = f"/assets/{'cd' * 32}/other.png"
    text = f"![keep]({other}) ![drop]({URL})"
    assert strip_asset_tokens(text, SHA) == f"![keep]({other})"


def test_leaves_page_links_alone():
    text = f"[[AI]] stuff ![x]({URL}) #tag"
    assert strip_asset_tokens(text, SHA) == "[[AI]] stuff #tag"


def test_no_token_is_identity_modulo_trim():
    assert strip_asset_tokens("plain text", SHA) == "plain text"


def test_image_only_block_becomes_empty():
    assert strip_asset_tokens(f"![]({URL})", SHA) == ""


# --- mime_category ---

@pytest.mark.parametrize("mime,cat", [
    ("image/png", "image"),
    ("image/heic", "image"),
    ("application/pdf", "pdf"),
    ("text/plain", "document"),
    ("text/csv", "document"),
    ("application/json", "document"),
    ("application/vnd.openxmlformats-officedocument"
     ".wordprocessingml.document", "document"),
    ("application/octet-stream", "other"),
])
def test_mime_category(mime, cat):
    assert mime_category(mime) == cat


# --- type_where: fragment must agree with mime_category ---

@pytest.mark.parametrize("mime", [
    "image/png", "application/pdf", "text/plain", "application/json",
    "application/vnd.ms-excel", "application/octet-stream",
])
@pytest.mark.parametrize("category", ["image", "pdf", "document", "other"])
def test_type_where_matches_mime_category(mime, category):
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE assets (mime TEXT)")
    db.execute("INSERT INTO assets VALUES (?)", (mime,))
    frag, params = type_where(category)
    n = db.execute(f"SELECT count(*) FROM assets WHERE {frag}",
                   params).fetchone()[0]
    assert (n == 1) == (mime_category(mime) == category)


# --- zip_arcnames ---

def test_zip_arcnames_no_collision_passthrough():
    entries = [("aa" * 32, "a.png"), ("bb" * 32, "b.png")]
    assert zip_arcnames(entries) == entries


def test_zip_arcnames_collision_gets_sha_prefix():
    entries = [("aa" * 32, "report.pdf"), ("bb" * 32, "report.pdf")]
    assert zip_arcnames(entries) == [
        ("aa" * 32, "report.pdf"),
        ("bb" * 32, f"report ({'bb' * 4}).pdf"),
    ]


def test_zip_arcnames_collision_is_case_insensitive():
    entries = [("aa" * 32, "Report.pdf"), ("bb" * 32, "report.pdf")]
    _, second = zip_arcnames(entries)[1]
    assert second == f"report ({'bb' * 4}).pdf"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_assets_core.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.assets_core'`

- [ ] **Step 3: Write the implementation**

Create `server/src/pkm/assets_core.py`:

```python
# pattern: Functional Core
"""Pure helpers for the asset file browser (pkm-jdu3): reference-token
stripping, mime categorisation (and its SQL twin), and zip arcname
de-duplication."""
from __future__ import annotations

import re
from pathlib import PurePosixPath

# Office + JSON mimes that count as "document" alongside text/*. Keep in
# step with ALLOWED_UPLOAD_MIME in routes_assets.py.
_DOCUMENT_MIME = (
    "application/json",
    "application/msword", "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument"
    ".wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument"
    ".spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument"
    ".presentationml.presentation",
)


def mime_category(mime: str) -> str:
    """The file-browser's coarse type buckets."""
    if mime.startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("text/") or mime in _DOCUMENT_MIME:
        return "document"
    return "other"


def type_where(category: str) -> tuple[str, list[str]]:
    """SQL fragment + params selecting assets whose mime falls in
    `category`. Must agree with mime_category (tested against it)."""
    doc = ("(mime LIKE 'text/%' OR mime IN ({}))"
           .format(",".join("?" * len(_DOCUMENT_MIME))))
    if category == "image":
        return "mime LIKE 'image/%'", []
    if category == "pdf":
        return "mime = 'application/pdf'", []
    if category == "document":
        return doc, list(_DOCUMENT_MIME)
    return (f"NOT (mime LIKE 'image/%' OR mime = 'application/pdf'"
            f" OR {doc})", list(_DOCUMENT_MIME))


def strip_asset_tokens(text: str, sha256: str) -> str:
    """Remove every reference to /assets/<sha256>/... from block text:
    image/link markdown tokens, the {{[[pdf]]: url}} macro, then any
    bare URL left over. Collapses doubled spaces and trims, so callers
    can test emptiness with a plain falsy check."""
    url = r"/assets/" + re.escape(sha256) + r"/[^\s)}]*"
    for pattern in (r"!?\[[^\]]*\]\(" + url + r"\)",
                    r"\{\{\[\[pdf\]\]:\s*" + url + r"\}\}",
                    url):
        text = re.sub(pattern, "", text)
    return re.sub(r" {2,}", " ", text).strip()


def zip_arcnames(entries: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Map (sha256, filename) pairs to unique zip arcnames: first use of
    a name wins, later case-insensitive collisions get ' (<sha8>)'
    before the suffix."""
    used: set[str] = set()
    out: list[tuple[str, str]] = []
    for sha, name in entries:
        arc = name
        if arc.lower() in used:
            p = PurePosixPath(name)
            arc = f"{p.stem} ({sha[:8]}){p.suffix}"
        used.add(arc.lower())
        out.append((sha, arc))
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_assets_core.py -q --no-cov`
Expected: all PASS

- [ ] **Step 5: Lint + typecheck**

Run: `cd server && uv run ruff check && uv run pyrefly check`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/assets_core.py server/tests/test_assets_core.py
git commit -m "feat(server): pure asset-browser helpers (pkm-jdu3)"
```

---

### Task 2: Extend `GET /api/assets/search` — filters, pagination, `total`

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py` (search route + `referencing_blocks` return type)
- Modify: `server/src/pkm/server/response_models.py:161-179`
- Modify: `server/tests/test_cli_render.py:190-197` (carry-over)
- Test: `server/tests/test_asset_search_filters.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

**Interfaces:**
- Consumes: `type_where` from Task 1; existing `referencing_blocks(db, sha256)`.
- Produces: `GET /api/assets/search?q=&limit=&offset=&type=&from_ms=&to_ms=&linked=` returning `{"total": int, "assets": [AssetSearchItem]}` where `AssetSearchItem` now also carries `describe_error: str | None` (the spec's "failed shows the error on hover" needs it). Tasks 5–7 rely on `total`, `offset`, `type`, `from_ms`, `to_ms`, `linked` exactly as named here.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_asset_search_filters.py`:

```python
"""Filters + pagination on GET /api/assets/search (pkm-jdu3)."""
from pkm.server.db import open_db


def _upload(client, content, name, mime="image/png"):
    r = client.post("/api/assets", files={"file": (name, content, mime)})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid, page_title, text):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": page_title,
                 "parent_uid": None, "order_idx": 0, "text": text}]})
    assert r.status_code == 200, r.text


def _set_created_at(config, sha, ms):
    db = open_db(config.db_path)
    db.execute("UPDATE assets SET created_at = ? WHERE sha256 = ?",
               (ms, sha))
    db.commit()
    db.close()


def _search(client, **params):
    r = client.get("/api/assets/search", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_type_filter(client):
    png = _upload(client, b"PNG1", "a.png")
    _upload(client, b"%PDF-1.4 x", "b.pdf", "application/pdf")
    got = _search(client, type="image")
    assert [a["sha256"] for a in got["assets"]] == [png["sha256"]]
    assert got["total"] == 1


def test_date_filter_bounds_inclusive_and_null_excluded(client,
                                                        seeded_config):
    early = _upload(client, b"E", "early.png")
    late = _upload(client, b"L", "late.png")
    undated = _upload(client, b"U", "undated.png")
    _set_created_at(seeded_config, early["sha256"], 1000)
    _set_created_at(seeded_config, late["sha256"], 2000)
    _set_created_at(seeded_config, undated["sha256"], None)
    got = _search(client, from_ms=1000, to_ms=1000)
    assert [a["sha256"] for a in got["assets"]] == [early["sha256"]]
    got = _search(client, from_ms=0)
    assert {a["sha256"] for a in got["assets"]} == {
        early["sha256"], late["sha256"]}


def test_linked_and_orphan_filters(client):
    linked = _upload(client, b"LNK", "linked.png")
    orphan = _upload(client, b"ORF", "orphan.png")
    _create_block(client, "flt1", "AI", f"pic ![]({linked['url']})")
    got = _search(client, linked="linked")
    assert [a["sha256"] for a in got["assets"]] == [linked["sha256"]]
    assert got["total"] == 1
    got = _search(client, linked="orphan")
    assert [a["sha256"] for a in got["assets"]] == [orphan["sha256"]]


def test_orphan_filter_paginates_over_filtered_set(client, seeded_config):
    shas = []
    for i in range(3):
        a = _upload(client, f"O{i}".encode(), f"o{i}.png")
        _set_created_at(seeded_config, a["sha256"], 1000 + i)
        shas.append(a["sha256"])
    linked = _upload(client, b"LNK", "linked.png")
    _set_created_at(seeded_config, linked["sha256"], 5000)
    _create_block(client, "flt2", "AI", f"![]({linked['url']})")
    got = _search(client, linked="orphan", limit=2, offset=0)
    assert got["total"] == 3
    # newest-first: o2, o1 on page one; o0 on page two
    assert [a["sha256"] for a in got["assets"]] == [shas[2], shas[1]]
    got = _search(client, linked="orphan", limit=2, offset=2)
    assert [a["sha256"] for a in got["assets"]] == [shas[0]]


def test_offset_past_end_returns_empty_with_total(client):
    _upload(client, b"X", "x.png")
    got = _search(client, offset=99)
    assert got["assets"] == [] and got["total"] == 1


def test_from_after_to_returns_empty(client, seeded_config):
    a = _upload(client, b"X", "x.png")
    _set_created_at(seeded_config, a["sha256"], 1500)
    got = _search(client, from_ms=2000, to_ms=1000)
    assert got["assets"] == [] and got["total"] == 0


def test_bad_type_and_linked_values_rejected(client):
    assert client.get("/api/assets/search",
                      params={"type": "video"}).status_code == 422
    assert client.get("/api/assets/search",
                      params={"linked": "nope"}).status_code == 422


def test_payload_carries_describe_error(client):
    a = _upload(client, b"X", "x.png")
    hit = next(h for h in _search(client)["assets"]
               if h["sha256"] == a["sha256"])
    assert hit["describe_error"] is None
    assert hit["status"] == "pending"


def test_filters_combine_with_q(client):
    a = _upload(client, b"A", "alpha-notes.png")
    _upload(client, b"B", "beta-notes.png")
    _upload(client, b"C", "alpha-notes.pdf", "application/pdf")
    got = _search(client, q="alpha", type="image")
    assert [x["sha256"] for x in got["assets"]] == [a["sha256"]]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_search_filters.py -q --no-cov`
Expected: FAIL — `total` missing / 422s not raised (extra params ignored today; the first assertions on `total` KeyError).

- [ ] **Step 3: Extend the response models**

In `server/src/pkm/server/response_models.py`, extend the existing asset models (currently at lines 161–179) to:

```python
class AssetRef(BaseModel):
    uid: str
    page_title: str


class AssetSearchItem(BaseModel):
    sha256: str
    filename: str
    mime: str
    size: int
    created_at: int | None
    url: str
    description: str | None
    status: Literal["described", "failed", "pending"]
    describe_error: str | None
    refs: list[AssetRef]


class AssetSearchPayload(BaseModel):
    total: int
    assets: list[AssetSearchItem]
```

(Keep the file's existing import of `Literal`; only the `describe_error` and `total` fields are new.)

- [ ] **Step 4: Rewrite the search route**

In `server/src/pkm/server/routes_assets.py`:

1. Extend imports: add `Query` to the `fastapi` import; add `from typing import Literal, Protocol` (Protocol is already imported — extend that line); add `from pkm.assets_core import type_where`.
2. Tighten `referencing_blocks`'s signature (pkm-t5pu carry-over):

```python
def referencing_blocks(db: sqlite3.Connection,
                       sha256: str) -> list[dict[str, str]]:
```

3. Replace the body of `search_assets` (keep its docstring's first two lines, extend as below):

```python
@router.get("/api/assets/search", response_model=AssetSearchPayload)
def search_assets(q: str = "", limit: int = 50, offset: int = 0,
                  type_: Literal["", "image", "pdf", "document", "other"]
                  = Query("", alias="type"),
                  from_ms: int | None = None, to_ms: int | None = None,
                  linked: Literal["all", "linked", "orphan"] = "all",
                  db: sqlite3.Connection = Depends(get_db)) -> dict:
    """LIKE search over description + filename (pkm-zc0c). Empty q lists
    most-recent uploads. LIKE, not FTS: personal-scale table, and no
    offline-parity burden. pkm-jdu3 adds type/date/linked filters,
    offset pagination, and a total count. linked/orphan filtering needs
    refs for every candidate, so that path scans the filtered set
    (personal scale keeps it cheap); linked=all computes refs only for
    the returned page."""
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    where_parts: list[str] = []
    params: list = []
    needle = q.strip()
    if needle:
        esc = (needle.replace("\\", "\\\\")
                     .replace("%", "\\%")
                     .replace("_", "\\_"))
        where_parts.append(r"(description LIKE ? ESCAPE '\'"
                           r" OR filename LIKE ? ESCAPE '\')")
        params += [f"%{esc}%", f"%{esc}%"]
    if type_:
        frag, type_params = type_where(type_)
        where_parts.append(frag)
        params += type_params
    if from_ms is not None:
        where_parts.append("created_at IS NOT NULL AND created_at >= ?")
        params.append(from_ms)
    if to_ms is not None:
        where_parts.append("created_at IS NOT NULL AND created_at <= ?")
        params.append(to_ms)
    where = f"WHERE {' AND '.join(where_parts)} " if where_parts else ""
    select = ("SELECT sha256, filename, mime, size, created_at,"
              " description, describe_error FROM assets ")
    order = "ORDER BY created_at IS NULL, created_at DESC, sha256 "
    if linked == "all":
        total = db.execute(f"SELECT count(*) FROM assets {where}",
                           params).fetchone()[0]
        rows = db.execute(select + where + order + "LIMIT ? OFFSET ?",
                          (*params, limit, offset)).fetchall()
        hits = [(r, referencing_blocks(db, r["sha256"])) for r in rows]
    else:
        rows = db.execute(select + where + order, params).fetchall()
        pairs = [(r, referencing_blocks(db, r["sha256"])) for r in rows]
        want_linked = linked == "linked"
        wanted = [(r, refs) for r, refs in pairs
                  if bool(refs) == want_linked]
        total = len(wanted)
        hits = wanted[offset:offset + limit]
    return {"total": total, "assets": [{
        "sha256": r["sha256"], "filename": r["filename"],
        "mime": r["mime"], "size": r["size"],
        "created_at": r["created_at"],
        "url": f"/assets/{r['sha256']}/{r['filename']}",
        "description": r["description"],
        "status": derive_status(r["description"], r["describe_error"]),
        "describe_error": r["describe_error"],
        "refs": refs,
    } for r, refs in hits]}
```

- [ ] **Step 5: Strengthen the CLI render carry-over test**

In `server/tests/test_cli_render.py`, `test_render_assets_tolerates_missing_refs_key` (line 190), add the final assertion:

```python
def test_render_assets_tolerates_missing_refs_key():
    payload = {"assets": [
        {"sha256": "ef" * 32, "filename": "old.png", "mime": "image/png",
         "size": 1, "created_at": None,
         "url": "/assets/" + "ef" * 32 + "/old.png",
         "description": None, "status": "pending"}]}
    out = render_assets(payload)
    assert "old.png" in out
    assert "in [[" not in out
```

- [ ] **Step 6: Run the new tests and the existing asset suites**

Run: `cd server && uv run pytest tests/test_asset_search_filters.py tests/test_asset_refs.py tests/test_asset_upload.py tests/test_cli_render.py -q --no-cov`
Expected: PASS. If any pre-existing test asserts the exact search payload shape (`== {"assets": ...}`), update it to include `total` and `describe_error`.

- [ ] **Step 7: Regenerate OpenAPI + web types**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

Run: `cd server && uv run pytest tests/test_openapi_sync.py -q --no-cov`
Expected: PASS

- [ ] **Step 8: Full server verification**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all green, coverage ≥95%.

- [ ] **Step 9: Commit**

```bash
git add server/src/pkm/server/routes_assets.py server/src/pkm/server/response_models.py \
  server/tests/test_asset_search_filters.py server/tests/test_cli_render.py \
  web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "feat(server): asset search filters, pagination, total (pkm-jdu3)"
```

---

### Task 3: `DELETE /api/assets/{sha256}`

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py`
- Test: `server/tests/test_asset_delete.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

**Interfaces:**
- Consumes: `strip_asset_tokens` (Task 1), `referencing_blocks`, `notify.nudge_threadpool`.
- Produces: `DELETE /api/assets/{sha256}` → `{"deleted": true, "refs_removed": <int changed-or-deleted block count>}`; 404 for unknown/malformed sha. Task 6's client loops this per sha.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_asset_delete.py`:

```python
"""DELETE /api/assets/{sha256}: strips links, deletes emptied leaf
blocks, removes row + file (pkm-jdu3)."""
from pkm.server.db import open_db


def _upload(client, content=b"PNGDATA", name="pic.png"):
    r = client.post("/api/assets",
                    files={"file": (name, content, "image/png")})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid, page_title, text, parent_uid=None,
                  order_idx=0):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": page_title,
                 "parent_uid": parent_uid, "order_idx": order_idx,
                 "text": text}]})
    assert r.status_code == 200, r.text


def _block_text(config, uid):
    db = open_db(config.db_path)
    row = db.execute("SELECT text FROM blocks WHERE uid = ?",
                     (uid,)).fetchone()
    db.close()
    return None if row is None else row["text"]


def _asset_path(config, sha):
    return config.assets_dir / sha[:2] / sha


def test_delete_orphan_removes_row_and_file(client, seeded_config):
    a = _upload(client)
    path = _asset_path(seeded_config, a["sha256"])
    assert path.is_file()
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "refs_removed": 0}
    assert not path.exists()
    hits = client.get("/api/assets/search").json()["assets"]
    assert a["sha256"] not in [h["sha256"] for h in hits]
    assert client.get(a["url"]).status_code == 404


def test_delete_unknown_sha_404(client):
    assert client.delete(f"/api/assets/{'0' * 64}").status_code == 404


def test_delete_malformed_sha_404(client):
    assert client.delete("/api/assets/not-a-sha").status_code == 404


def test_delete_strips_token_keeps_block_with_text(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del1", "AI", f"diagram: ![x]({a['url']})")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json() == {"deleted": True, "refs_removed": 1}
    assert _block_text(seeded_config, "del1") == "diagram:"


def test_delete_removes_emptied_leaf_block(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del2", "AI", f"![]({a['url']})")
    client.delete(f"/api/assets/{a['sha256']}")
    assert _block_text(seeded_config, "del2") is None


def test_emptied_block_with_children_is_kept(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del3", "AI", f"![]({a['url']})")
    _create_block(client, "del3kid", "AI", "child text",
                  parent_uid="del3", order_idx=0)
    client.delete(f"/api/assets/{a['sha256']}")
    assert _block_text(seeded_config, "del3") == ""
    assert _block_text(seeded_config, "del3kid") == "child text"


def test_deleted_block_drops_out_of_fts_refs(client):
    """Pins the FTS delete trigger user-visibly (pkm-t5pu carry-over):
    after the referencing block is deleted, a SECOND asset embedded in
    the same block no longer reports it."""
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.png")
    _create_block(client, "del4", "AI", f"![]({a['url']}) ![]({b['url']})")
    # deleting asset A strips its token; block still holds B's token
    client.delete(f"/api/assets/{a['sha256']}")
    hit = next(h for h in client.get("/api/assets/search").json()["assets"]
               if h["sha256"] == b["sha256"])
    assert hit["refs"] == [{"uid": "del4", "page_title": "AI"}]
    # now delete B: block becomes empty -> deleted -> FTS row gone
    client.delete(f"/api/assets/{b['sha256']}")
    c = _upload(client, b"BBB", "b.png")  # same bytes, same sha as B
    hit = next(h for h in client.get("/api/assets/search").json()["assets"]
               if h["sha256"] == c["sha256"])
    assert hit["refs"] == []


def test_delete_with_missing_disk_file_still_removes_row(client,
                                                         seeded_config):
    a = _upload(client)
    _asset_path(seeded_config, a["sha256"]).unlink()
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.status_code == 200
    hits = client.get("/api/assets/search").json()["assets"]
    assert a["sha256"] not in [h["sha256"] for h in hits]


def test_delete_strips_pdf_macro_and_bare_url(client, seeded_config):
    a = _upload(client)
    _create_block(client, "del5", "AI",
                  f"{{{{[[pdf]]: {a['url']}}}}} see also {a['url']}")
    r = client.delete(f"/api/assets/{a['sha256']}")
    assert r.json()["refs_removed"] == 1
    assert _block_text(seeded_config, "del5") == "see also"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_delete.py -q --no-cov`
Expected: FAIL — 405 Method Not Allowed (no DELETE route yet).

- [ ] **Step 3: Implement the route**

In `server/src/pkm/server/routes_assets.py`:

1. Add imports: `import logging`; extend the assets_core import to `from pkm.assets_core import strip_asset_tokens, type_where`; add `from pkm.server import notify` (mirrors `routes_pages.py`). Add a module logger after the router definition: `logger = logging.getLogger("pkm.assets")`.
2. Add the route (after `search_assets`):

```python
@router.delete("/api/assets/{sha256}")
def delete_asset(request: Request, sha256: str,
                 db: sqlite3.Connection = Depends(get_db),
                 config: Config = Depends(get_config)) -> dict:
    """Delete an asset: strip every reference token from block text
    (blocks left empty with no children are deleted outright — asset
    deletion must never cascade away real content, so emptied parents
    are kept), drop the assets row, commit, then best-effort unlink the
    file. Commit-before-unlink: a crash leaves at worst an unreferenced
    file on disk, never a row pointing at a missing file. Asset URLs
    never contribute refs rows ([[link]]/#tag/attr:: only), so no refs
    reindex is needed; refs rows of deleted blocks go via FK cascade,
    and the explicit per-uid DELETE keeps the FTS delete trigger
    firing."""
    if not _SHA_RE.match(sha256):
        raise HTTPException(status_code=404, detail="asset not found")
    row = db.execute("SELECT sha256 FROM assets WHERE sha256 = ?",
                     (sha256,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    now_ms = int(time.time() * 1000)
    refs_removed = 0
    for ref in referencing_blocks(db, sha256):
        block = db.execute("SELECT text FROM blocks WHERE uid = ?",
                           (ref["uid"],)).fetchone()
        if block is None:
            continue
        new_text = strip_asset_tokens(block["text"], sha256)
        if new_text == block["text"]:
            continue
        refs_removed += 1
        has_children = db.execute(
            "SELECT 1 FROM blocks WHERE parent_uid = ? LIMIT 1",
            (ref["uid"],)).fetchone() is not None
        if not new_text and not has_children:
            db.execute("DELETE FROM blocks WHERE uid = ?", (ref["uid"],))
        else:
            db.execute("UPDATE blocks SET text = ?, updated_at = ?"
                       " WHERE uid = ?", (new_text, now_ms, ref["uid"]))
    db.execute("DELETE FROM assets WHERE sha256 = ?", (sha256,))
    db.commit()
    path = config.assets_dir / sha256[:2] / sha256
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("could not remove asset file %s", path)
    notify.nudge_threadpool(request, db)
    return {"deleted": True, "refs_removed": refs_removed}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_asset_delete.py -q --no-cov`
Expected: all PASS

- [ ] **Step 5: Regenerate OpenAPI + types, full server verification**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
cd ../server && uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: all green. (The DELETE route returns a small ad-hoc ack like `DELETE /api/page` — write routes aren't response-model-checked.)

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/routes_assets.py server/tests/test_asset_delete.py \
  web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "feat(server): DELETE /api/assets/{sha} strips links, removes file (pkm-jdu3)"
```

---

### Task 4: `POST /api/assets/export.zip`

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py`
- Test: `server/tests/test_asset_export.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

**Interfaces:**
- Consumes: `zip_arcnames` (Task 1).
- Produces: `POST /api/assets/export.zip` accepting repeated **form** fields `sha256s` (form-encoded so a plain browser `<form method="post">` can drive it — Task 6 submits exactly that), returning `application/zip` with `Content-Disposition: attachment; filename="assets-YYYY-MM-DD.zip"`. Unknown/malformed/missing-file shas are skipped.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_asset_export.py`:

```python
"""POST /api/assets/export.zip: zip of selected assets (pkm-jdu3)."""
import io
import zipfile
from datetime import date


def _upload(client, content, name, mime="image/png"):
    r = client.post("/api/assets", files={"file": (name, content, mime)})
    assert r.status_code == 200
    return r.json()


def _export(client, shas):
    return client.post("/api/assets/export.zip",
                       data={"sha256s": shas})


def _names(resp):
    return sorted(zipfile.ZipFile(io.BytesIO(resp.content)).namelist())


def test_export_selected_assets(client):
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.pdf", "application/pdf")
    _upload(client, b"CCC", "c.png")  # not selected
    r = _export(client, [a["sha256"], b["sha256"]])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    expected = f'attachment; filename="assets-{date.today().isoformat()}.zip"'
    assert r.headers["content-disposition"] == expected
    assert _names(r) == ["a.png", "b.pdf"]
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert zf.read("a.png") == b"AAA"


def test_export_filename_collision_gets_sha_prefix(client):
    a = _upload(client, b"AAA", "report.pdf", "application/pdf")
    b = _upload(client, b"BBB", "report.pdf", "application/pdf")
    r = _export(client, [a["sha256"], b["sha256"]])
    names = _names(r)
    assert "report.pdf" in names
    assert any(n.startswith("report (") and n.endswith(").pdf")
               for n in names)


def test_export_skips_unknown_and_malformed_and_duplicates(client):
    a = _upload(client, b"AAA", "a.png")
    r = _export(client, [a["sha256"], a["sha256"], "0" * 64, "junk"])
    assert r.status_code == 200
    assert _names(r) == ["a.png"]


def test_export_skips_missing_disk_file(client, seeded_config):
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.png")
    (seeded_config.assets_dir / b["sha256"][:2] / b["sha256"]).unlink()
    r = _export(client, [a["sha256"], b["sha256"]])
    assert _names(r) == ["a.png"]


def test_export_empty_selection_returns_empty_zip(client):
    r = _export(client, [])
    assert r.status_code == 200
    assert _names(r) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_export.py -q --no-cov`
Expected: FAIL — 405 Method Not Allowed.

- [ ] **Step 3: Implement the route**

In `server/src/pkm/server/routes_assets.py`:

1. Add imports: `import io`, `import zipfile`, `from datetime import date`; add `Form` and `Response` to the `fastapi` import line; extend the assets_core import to include `zip_arcnames`.
2. Add the route:

```python
@router.post("/api/assets/export.zip")
def export_assets(sha256s: list[str] = Form(default=[]),
                  db: sqlite3.Connection = Depends(get_db),
                  config: Config = Depends(get_config)) -> Response:
    """Zip the selected assets under their original filenames (name
    collisions get a short sha prefix via zip_arcnames). Form-encoded so
    the web app can drive it with a plain <form method="post"> and let
    the browser own the download. Unknown, malformed, duplicate, and
    missing-on-disk shas are skipped, not errors: the zip honestly
    contains what could be exported. In-RAM like /api/export.zip —
    bounded by the user's selection."""
    chosen: list[tuple[str, str, Path]] = []
    for sha in dict.fromkeys(sha256s):
        if not _SHA_RE.match(sha):
            continue
        row = db.execute("SELECT filename FROM assets WHERE sha256 = ?",
                         (sha,)).fetchone()
        if row is None:
            continue
        path = config.assets_dir / sha[:2] / sha
        if not path.is_file():
            continue
        chosen.append((sha, row["filename"], path))
    arcs = zip_arcnames([(sha, name) for sha, name, _ in chosen])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for (_, _, path), (_, arc) in zip(chosen, arcs):
            zf.write(path, arc)
    filename = f"assets-{date.today().isoformat()}.zip"
    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition":
                 f'attachment; filename="{filename}"'})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_asset_export.py -q --no-cov`
Expected: all PASS

- [ ] **Step 5: Regenerate OpenAPI + types, full server verification**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
cd ../server && uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: all green. If `test_openapi_sync.py` flags the new POST route for a response model, add `"/api/assets/export.zip"` to `EXEMPT_READ_ROUTES` (`server/tests/test_openapi_sync.py:31`) — it's a binary download like `/api/export.zip`.

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/routes_assets.py server/tests/test_asset_export.py \
  web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "feat(server): POST /api/assets/export.zip for selected assets (pkm-jdu3)"
```

---

### Task 5: Web functional core — types + `filesCore.ts`

**Files:**
- Modify: `web/src/api/payloads.ts` (add re-exports)
- Create: `web/src/views/filesCore.ts`
- Test: `web/src/views/filesCore.test.ts`

**Interfaces:**
- Consumes: generated `Schemas["AssetSearchItem"]` etc. from `web/src/api/types.d.ts` (regenerated in Tasks 2–4).
- Produces (Task 6 imports all of these by exactly these names):
  - `type FileFilters = { q: string; type: "" | "image" | "pdf" | "document" | "other"; fromDate: string; toDate: string; linked: "all" | "linked" | "orphan" }`
  - `EMPTY_FILTERS: FileFilters`, `PAGE_SIZE = 50`
  - `searchParams(f: FileFilters, offset: number): string`
  - `mimeCategory(mime: string): "image" | "pdf" | "document" | "other"`
  - `clipboardToken(item: Pick<AssetSearchItem, "filename" | "mime" | "url">): string`
  - `deleteConfirm(items: AssetSearchItem[]): { message: string; loud: boolean }`
  - `summarizeDeletes(ok: number, failures: string[]): string`
  - `formatSize(bytes: number): string`

- [ ] **Step 1: Add the payload re-exports**

In `web/src/api/payloads.ts`, alongside the existing re-exports add:

```ts
export type AssetRef = Schemas["AssetRef"];
export type AssetSearchItem = Schemas["AssetSearchItem"];
export type AssetSearchPayload = Schemas["AssetSearchPayload"];
export type ScanPayload = Schemas["ScanPayload"];
```

(Match the file's existing `Schemas` alias/import style exactly.)

- [ ] **Step 2: Write the failing tests**

Create `web/src/views/filesCore.test.ts`:

```ts
// pattern: Functional Core
import { describe, expect, it } from "vitest";
import type { AssetSearchItem } from "../api/payloads";
import {
  EMPTY_FILTERS, PAGE_SIZE, clipboardToken, deleteConfirm, formatSize,
  mimeCategory, searchParams, summarizeDeletes,
} from "./filesCore";

const item = (over: Partial<AssetSearchItem>): AssetSearchItem => ({
  sha256: "ab".repeat(32), filename: "pic.png", mime: "image/png",
  size: 1234, created_at: 1753000000000,
  url: `/assets/${"ab".repeat(32)}/pic.png`, description: null,
  status: "pending", describe_error: null, refs: [], ...over,
});

describe("searchParams", () => {
  it("always carries limit and offset", () => {
    const p = new URLSearchParams(searchParams(EMPTY_FILTERS, 50));
    expect(p.get("limit")).toBe(String(PAGE_SIZE));
    expect(p.get("offset")).toBe("50");
    expect(p.get("q")).toBeNull();
    expect(p.get("linked")).toBeNull();
  });

  it("maps filters to query params", () => {
    const p = new URLSearchParams(searchParams({
      q: " cat ", type: "pdf", fromDate: "2026-07-01",
      toDate: "2026-07-31", linked: "orphan",
    }, 0));
    expect(p.get("q")).toBe("cat");
    expect(p.get("type")).toBe("pdf");
    expect(p.get("linked")).toBe("orphan");
    expect(Number(p.get("from_ms"))).toBe(
      new Date(2026, 6, 1).getTime());
    expect(Number(p.get("to_ms"))).toBe(
      new Date(2026, 6, 31, 23, 59, 59, 999).getTime());
  });
});

describe("mimeCategory", () => {
  it.each([
    ["image/webp", "image"], ["application/pdf", "pdf"],
    ["text/csv", "document"], ["application/json", "document"],
    ["application/octet-stream", "other"],
  ])("%s -> %s", (mime, cat) => {
    expect(mimeCategory(mime)).toBe(cat);
  });
});

describe("clipboardToken", () => {
  it("uses image syntax for images", () => {
    expect(clipboardToken(item({}))).toBe(
      `![pic.png](/assets/${"ab".repeat(32)}/pic.png)`);
  });
  it("uses link syntax otherwise", () => {
    const i = item({ mime: "application/pdf", filename: "r.pdf" });
    expect(clipboardToken(i)).toBe(`[r.pdf](${i.url})`);
  });
});

describe("deleteConfirm", () => {
  it("is calm when nothing is linked", () => {
    const { message, loud } = deleteConfirm([item({}), item({})]);
    expect(loud).toBe(false);
    expect(message).toBe("Delete 2 files? None are linked from any page.");
  });
  it("singular form for one file", () => {
    expect(deleteConfirm([item({})]).message).toBe(
      "Delete 1 file? None are linked from any page.");
  });
  it("is loud and lists pages when linked", () => {
    const linked = item({
      filename: "used.png",
      refs: [{ uid: "b1", page_title: "AI" },
             { uid: "b2", page_title: "AI" },
             { uid: "b3", page_title: "Paper" }],
    });
    const { message, loud } = deleteConfirm([linked, item({})]);
    expect(loud).toBe(true);
    expect(message).toContain("Delete 2 files? 1 is still linked:");
    expect(message).toContain("used.png — linked from AI, Paper");
    expect(message).toContain(
      "This removes 3 links from 3 blocks; blocks left empty are deleted.");
  });
});

describe("summarizeDeletes", () => {
  it("plain success", () => {
    expect(summarizeDeletes(3, [])).toBe("Deleted 3 files.");
    expect(summarizeDeletes(1, [])).toBe("Deleted 1 file.");
  });
  it("reports failures", () => {
    expect(summarizeDeletes(2, ["a.png", "b.pdf"])).toBe(
      "Deleted 2 of 4 files. Failed: a.png, b.pdf");
  });
});

describe("formatSize", () => {
  it.each([
    [512, "512 B"], [2048, "2.0 KB"], [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ])("%d -> %s", (bytes, out) => {
    expect(formatSize(bytes)).toBe(out);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && pnpm test:unit src/views/filesCore.test.ts`
Expected: FAIL — cannot resolve `./filesCore`.

- [ ] **Step 4: Write the implementation**

Create `web/src/views/filesCore.ts`:

```ts
// pattern: Functional Core
// Pure logic for the /files asset browser (pkm-jdu3). The Files view is
// the imperative shell; everything testable without I/O lives here.
import type { AssetSearchItem } from "../api/payloads";

export interface FileFilters {
  q: string;
  type: "" | "image" | "pdf" | "document" | "other";
  fromDate: string; // yyyy-mm-dd or ""
  toDate: string;
  linked: "all" | "linked" | "orphan";
}

export const EMPTY_FILTERS: FileFilters = {
  q: "", type: "", fromDate: "", toDate: "", linked: "all",
};

export const PAGE_SIZE = 50;

// Date-only strings parse as UTC midnight per spec; construct via local
// components instead so the day boundary is the user's, not UTC's.
function localMs(date: string, endOfDay: boolean): number {
  const [y, m, d] = date.split("-").map(Number);
  return endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, m - 1, d).getTime();
}

export function searchParams(f: FileFilters, offset: number): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.type) p.set("type", f.type);
  if (f.fromDate) p.set("from_ms", String(localMs(f.fromDate, false)));
  if (f.toDate) p.set("to_ms", String(localMs(f.toDate, true)));
  if (f.linked !== "all") p.set("linked", f.linked);
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String(offset));
  return p.toString();
}

const DOCUMENT_MIME = new Set([
  "application/json",
  "application/msword", "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument"
    + ".wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument"
    + ".spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument"
    + ".presentationml.presentation",
]);

export function mimeCategory(
  mime: string,
): "image" | "pdf" | "document" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || DOCUMENT_MIME.has(mime)) {
    return "document";
  }
  return "other";
}

export function clipboardToken(
  item: Pick<AssetSearchItem, "filename" | "mime" | "url">,
): string {
  const bang = item.mime.startsWith("image/") ? "!" : "";
  return `${bang}[${item.filename}](${item.url})`;
}

const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

export function deleteConfirm(
  items: AssetSearchItem[],
): { message: string; loud: boolean } {
  const linked = items.filter((i) => i.refs.length > 0);
  const head = `Delete ${plural(items.length, "file")}?`;
  if (linked.length === 0) {
    return { message: `${head} None are linked from any page.`,
             loud: false };
  }
  const lines = linked.map((i) => {
    const pages = [...new Set(i.refs.map((r) => r.page_title))];
    return `${i.filename} — linked from ${pages.join(", ")}`;
  });
  const refs = linked.reduce((sum, i) => sum + i.refs.length, 0);
  const still = linked.length === 1 ? "1 is" : `${linked.length} are`;
  return {
    loud: true,
    message: `${head} ${still} still linked:\n${lines.join("\n")}\n`
      + `This removes ${plural(refs, "link")} from `
      + `${plural(refs, "block")}; blocks left empty are deleted.`,
  };
}

export function summarizeDeletes(ok: number, failures: string[]): string {
  if (failures.length === 0) return `Deleted ${plural(ok, "file")}.`;
  return `Deleted ${ok} of ${ok + failures.length} files.`
    + ` Failed: ${failures.join(", ")}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

Note: `deleteConfirm` counts each ref as one block (refs are per-block rows from `referencing_blocks`), so links == blocks in the message — that matches the server's `refs` shape where one block appears once per asset.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && pnpm test:unit src/views/filesCore.test.ts`
Expected: all PASS

- [ ] **Step 6: Typecheck and commit**

Run: `cd web && pnpm typecheck`
Expected: clean

```bash
git add web/src/api/payloads.ts web/src/views/filesCore.ts web/src/views/filesCore.test.ts
git commit -m "feat(web): asset types + files-view functional core (pkm-jdu3)"
```

---

### Task 6: The `Files` view, route, nav, styles

**Files:**
- Create: `web/src/views/Files.tsx`
- Test: `web/src/views/Files.test.tsx`
- Modify: `web/src/App.tsx` (import + nav link + route), `web/src/App.test.tsx` (route case)
- Modify: `web/src/styles.css` (append `.files-*` rules at end)

**Interfaces:**
- Consumes: everything Task 5 produces; `apiFetch` (`web/src/api/client.ts:97`); `useConfirm` (`web/src/components/ConfirmDialog.tsx:34`, returns `{ confirm(message, options?): Promise<boolean>, dialog: ReactNode }`); `useSync` (`web/src/sync/SyncProvider.tsx:87`, `status: "connecting" | "connected" | "reconnecting"`); server routes from Tasks 2–4.
- Produces: `export function Files()` mounted at `/files`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/views/Files.test.tsx`. Mock `apiFetch` and `useSync`; use the real `useConfirm` (it portals into the test DOM):

```tsx
// pattern: Imperative Shell
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSearchItem, AssetSearchPayload } from "../api/payloads";
import { makeSync } from "../test-helpers";
import { Files } from "./Files";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("../sync/SyncProvider", () => ({ useSync: vi.fn() }));

import { apiFetch } from "../api/client";
import { useSync } from "../sync/SyncProvider";

const mockFetch = vi.mocked(apiFetch);
const mockSync = vi.mocked(useSync);

const item = (over: Partial<AssetSearchItem>): AssetSearchItem => ({
  sha256: "ab".repeat(32), filename: "pic.png", mime: "image/png",
  size: 1234, created_at: 1753000000000,
  url: `/assets/${"ab".repeat(32)}/pic.png`, description: null,
  status: "described", describe_error: null, refs: [], ...over,
});

const payload = (assets: AssetSearchItem[],
                 total = assets.length): AssetSearchPayload =>
  ({ total, assets });

beforeEach(() => {
  vi.clearAllMocks();
  mockSync.mockReturnValue(makeSync("connected"));
  mockFetch.mockResolvedValue(payload([]));
});

describe("Files", () => {
  it("shows the offline note without fetching when disconnected", () => {
    mockSync.mockReturnValue(makeSync("reconnecting"));
    render(<Files />);
    expect(screen.getByText(/needs a connection/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shows an empty state", async () => {
    render(<Files />);
    expect(await screen.findByText(/no files match/i)).toBeInTheDocument();
  });

  it("shows an error state when the fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    render(<Files />);
    expect(
      await screen.findByText(/could not load files/i),
    ).toBeInTheDocument();
  });

  it("renders cards with badges, thumbnail, and count line", async () => {
    mockFetch.mockResolvedValue(payload([
      item({}),
      item({
        sha256: "cd".repeat(32), filename: "notes.pdf",
        mime: "application/pdf", status: "failed",
        describe_error: "too large",
        refs: [{ uid: "b1", page_title: "AI" }],
      }),
    ]));
    render(<Files />);
    expect(await screen.findByText("pic.png")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "pic.png" }))
      .toHaveAttribute("src", expect.stringContaining("/assets/"));
    expect(screen.getByText("orphan")).toBeInTheDocument();
    expect(screen.getByText("1 ref")).toBeInTheDocument();
    expect(screen.getByText("failed")).toHaveAttribute(
      "title", "too large");
    expect(screen.getByText("2 of 2 files")).toBeInTheDocument();
  });

  it("passes filters to the search request", async () => {
    render(<Files />);
    await screen.findByText(/no files match/i);
    fireEvent.change(screen.getByLabelText("Type"),
                     { target: { value: "pdf" } });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("type=pdf")));
    fireEvent.change(screen.getByLabelText("Linked"),
                     { target: { value: "orphan" } });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("linked=orphan")));
  });

  it("loads more pages and selects all across pages", async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      item({ sha256: String(i).padStart(64, "0"),
             filename: `f${i}.png` }));
    const second = [item({ sha256: "ee".repeat(32),
                           filename: "last.png" })];
    mockFetch
      .mockResolvedValueOnce(payload(first, 51))
      .mockResolvedValueOnce(payload(second, 51));
    render(<Files />);
    expect(await screen.findByText("50 of 51 files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await screen.findByText("51 selected");
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("offset=50"));
  });

  it("deletes selected files after a calm confirm and reports", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    mockFetch.mockResolvedValueOnce({ deleted: true, refs_removed: 0 });
    mockFetch.mockResolvedValueOnce(payload([]));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(
      /Delete 1 file\? None are linked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(await screen.findByText("Deleted 1 file.")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/assets/${"ab".repeat(32)}`, { method: "DELETE" });
  });

  it("goes loud when a linked file is selected and survives failures",
     async () => {
    const linked = item({
      refs: [{ uid: "b1", page_title: "AI" }] });
    const other = item({ sha256: "cd".repeat(32), filename: "b.png" });
    mockFetch.mockResolvedValueOnce(payload([linked, other]));
    render(<Files />);
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByLabelText("Select b.png"));
    mockFetch
      .mockRejectedValueOnce(new Error("500"))     // delete pic.png
      .mockResolvedValueOnce({ deleted: true, refs_removed: 0 })
      .mockResolvedValueOnce(payload([linked]));   // refetch
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/still linked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete files" }));
    expect(await screen.findByText(
      "Deleted 1 of 2 files. Failed: pic.png")).toBeInTheDocument();
  });

  it("cancelling the confirm deletes nothing", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("ab".repeat(32)),
      expect.objectContaining({ method: "DELETE" }));
  });

  it("copies an orphan's markdown token", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
    fireEvent.click(await screen.findByRole("button",
                                            { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `![pic.png](/assets/${"ab".repeat(32)}/pic.png)`));
    expect(screen.getByText("Link copied.")).toBeInTheDocument();
  });

  it("runs a scan and reports the queue size", async () => {
    mockFetch.mockResolvedValueOnce(payload([]));
    render(<Files />);
    await screen.findByText(/no files match/i);
    mockFetch.mockResolvedValueOnce(
      { queued: 4, enabled: true, reason: null });
    mockFetch.mockResolvedValueOnce(payload([]));
    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    expect(await screen.findByText("Scan queued 4 files."))
      .toBeInTheDocument();
  });

  it("reports the disabled reason when describe is off", async () => {
    mockFetch.mockResolvedValueOnce(payload([]));
    render(<Files />);
    await screen.findByText(/no files match/i);
    mockFetch.mockResolvedValueOnce(
      { queued: 0, enabled: false, reason: "no key" });
    mockFetch.mockResolvedValueOnce(payload([]));
    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    expect(await screen.findByText(/disabled — no key/))
      .toBeInTheDocument();
  });

  it("submits a hidden form for export", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    render(<Files />);
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(submit).toHaveBeenCalledOnce();
    submit.mockRestore();
  });

  it("falls back to a type label when the image is broken", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
    fireEvent.error(await screen.findByRole("img", { name: "pic.png" }));
    expect(screen.getByText("image")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx`
Expected: FAIL — cannot resolve `./Files`.

- [ ] **Step 3: Write the view**

Create `web/src/views/Files.tsx`:

```tsx
// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type {
  AssetSearchItem, AssetSearchPayload, ScanPayload,
} from "../api/payloads";
import { useConfirm } from "../components/ConfirmDialog";
import { useSync } from "../sync/SyncProvider";
import {
  EMPTY_FILTERS, PAGE_SIZE, clipboardToken, deleteConfirm, formatSize,
  mimeCategory, searchParams, summarizeDeletes,
} from "./filesCore";
import type { FileFilters } from "./filesCore";

function submitExportForm(sha256s: string[]) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/api/assets/export.zip";
  form.style.display = "none";
  for (const sha of sha256s) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "sha256s";
    input.value = sha;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function FileCard({ item, checked, onToggle, onCopy }: {
  item: AssetSearchItem;
  checked: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const category = mimeCategory(item.mime);
  const [broken, setBroken] = useState(false);
  const when = item.created_at
    ? ` · ${new Date(item.created_at).toLocaleDateString()}` : "";
  return (
    <div className={"file-card" + (checked ? " selected" : "")}>
      <a className="file-thumb" href={item.url} target="_blank"
         rel="noreferrer">
        {category === "image" && !broken
          ? <img src={item.url} alt={item.filename} loading="lazy"
                 onError={() => setBroken(true)} />
          : <span className="file-type-label">{category}</span>}
      </a>
      <span className="file-name" title={item.filename}>
        {item.filename}
      </span>
      <span className="file-sub">{formatSize(item.size)}{when}</span>
      <span className="file-badges">
        <span className={`file-badge status-${item.status}`}
              title={item.describe_error ?? undefined}>
          {item.status}
        </span>
        <span className={"file-badge "
                         + (item.refs.length ? "linked" : "orphan")}>
          {item.refs.length
            ? `${item.refs.length} ref${item.refs.length === 1 ? "" : "s"}`
            : "orphan"}
        </span>
      </span>
      {item.refs.length === 0 && (
        <button type="button" className="btn-secondary file-copy"
                onClick={onCopy}>
          Copy link
        </button>
      )}
      <label className="file-select">
        <input type="checkbox" checked={checked} onChange={onToggle}
               aria-label={`Select ${item.filename}`} />
      </label>
    </div>
  );
}

export function Files() {
  const { status } = useSync();
  const offline = status !== "connected";
  const { confirm, dialog } = useConfirm();
  const [filters, setFilters] = useState<FileFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<AssetSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] =
    useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] =
    useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Stale-response guard: only the latest reload may set state.
  const generation = useRef(0);

  useEffect(() => { document.title = "Files — pkm"; }, []);

  const fetchPage = useCallback(
    (f: FileFilters, offset: number) =>
      apiFetch<AssetSearchPayload>(
        `/api/assets/search?${searchParams(f, offset)}`),
    []);

  const reload = useCallback((f: FileFilters) => {
    const gen = ++generation.current;
    setState("loading");
    fetchPage(f, 0)
      .then((p) => {
        if (generation.current !== gen) return;
        setItems(p.assets);
        setTotal(p.total);
        setSelected(new Set());
        setState("ready");
      })
      .catch(() => {
        if (generation.current === gen) setState("error");
      });
  }, [fetchPage]);

  useEffect(() => {
    if (offline) return;
    const t = setTimeout(() => reload(filters), 250);
    return () => clearTimeout(t);
  }, [filters, offline, reload]);

  const update = (patch: Partial<FileFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  const loadMore = async () => {
    try {
      const p = await fetchPage(filters, items.length);
      setItems((cur) => [...cur, ...p.assets]);
      setTotal(p.total);
    } catch {
      setNotice("Could not load more files.");
    }
  };

  const selectAll = async () => {
    setBusy(true);
    try {
      let all = items;
      while (all.length < total) {
        const p = await fetchPage(filters, all.length);
        if (p.assets.length === 0) break;
        all = [...all, ...p.assets];
      }
      setItems(all);
      setSelected(new Set(all.map((i) => i.sha256)));
    } catch {
      setNotice("Could not load the full selection.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (sha: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });

  const deleteSelected = async () => {
    const chosen = items.filter((i) => selected.has(i.sha256));
    const { message, loud } = deleteConfirm(chosen);
    const ok = await confirm(message, {
      danger: true,
      title: loud ? "Delete linked files" : "Delete files",
      confirmLabel: `Delete ${chosen.length === 1 ? "file" : "files"}`,
    });
    if (!ok) return;
    setBusy(true);
    const failures: string[] = [];
    let deleted = 0;
    for (const item of chosen) {
      try {
        await apiFetch(`/api/assets/${item.sha256}`,
                       { method: "DELETE" });
        deleted += 1;
      } catch {
        failures.push(item.filename);
      }
    }
    setBusy(false);
    setNotice(summarizeDeletes(deleted, failures));
    reload(filters);
  };

  const copyLink = async (item: AssetSearchItem) => {
    await navigator.clipboard.writeText(clipboardToken(item));
    setNotice("Link copied.");
  };

  const runScan = async () => {
    try {
      const p = await apiFetch<ScanPayload>("/api/assets/scan",
                                            { method: "POST" });
      setNotice(p.enabled
        ? `Scan queued ${p.queued} file${p.queued === 1 ? "" : "s"}.`
        : `Image descriptions are disabled — ${p.reason}`);
    } catch {
      setNotice("Scan failed.");
    }
    reload(filters);
  };

  if (offline) {
    return (
      <article className="files-page">
        <h1 className="page-title">Files</h1>
        <p className="settings-note">
          Files needs a connection — reconnect to browse attachments.
        </p>
      </article>
    );
  }

  return (
    <article className="files-page">
      <h1 className="page-title">Files</h1>
      <div className="files-filters">
        <input type="search" value={filters.q} placeholder="Search files"
               aria-label="Search files"
               onChange={(e) => update({ q: e.target.value })} />
        <label>Type{" "}
          <select value={filters.type} aria-label="Type"
                  onChange={(e) => update({
                    type: e.target.value as FileFilters["type"] })}>
            <option value="">All</option>
            <option value="image">Images</option>
            <option value="pdf">PDFs</option>
            <option value="document">Documents</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>From{" "}
          <input type="date" value={filters.fromDate} aria-label="From"
                 onChange={(e) => update({ fromDate: e.target.value })} />
        </label>
        <label>To{" "}
          <input type="date" value={filters.toDate} aria-label="To"
                 onChange={(e) => update({ toDate: e.target.value })} />
        </label>
        <label>Linked{" "}
          <select value={filters.linked} aria-label="Linked"
                  onChange={(e) => update({
                    linked: e.target.value as FileFilters["linked"] })}>
            <option value="all">All</option>
            <option value="linked">Linked</option>
            <option value="orphan">Orphans</option>
          </select>
        </label>
      </div>
      <div className="files-toolbar">
        <span className="files-count">
          {items.length} of {total} files
        </span>
        <button type="button" className="btn-secondary" disabled={busy}
                onClick={selectAll}>
          Select all
        </button>
        {selected.size > 0 && (
          <>
            <span className="files-count">{selected.size} selected</span>
            <button type="button" className="btn-secondary" disabled={busy}
                    onClick={() =>
                      submitExportForm([...selected])}>
              Export
            </button>
            <button type="button" className="btn-danger" disabled={busy}
                    onClick={deleteSelected}>
              Delete
            </button>
          </>
        )}
        <button type="button" className="btn-secondary" disabled={busy}
                onClick={runScan}>
          Scan for undescribed files
        </button>
        <button type="button" className="btn-secondary" disabled={busy}
                onClick={() => reload(filters)}>
          Refresh
        </button>
      </div>
      {notice && <p className="settings-note files-notice">{notice}</p>}
      {state === "loading" && <p className="settings-note">Loading…</p>}
      {state === "error" && (
        <p className="settings-note">Could not load files.</p>
      )}
      {state === "ready" && items.length === 0 && (
        <p className="settings-note">No files match these filters.</p>
      )}
      {state === "ready" && items.length > 0 && (
        <div className="files-grid">
          {items.map((item) => (
            <FileCard key={item.sha256} item={item}
                      checked={selected.has(item.sha256)}
                      onToggle={() => toggle(item.sha256)}
                      onCopy={() => copyLink(item)} />
          ))}
        </div>
      )}
      {state === "ready" && items.length < total && (
        <button type="button" className="btn-secondary files-more"
                onClick={loadMore}>
          Load more
        </button>
      )}
      {dialog}
    </article>
  );
}
```

- [ ] **Step 4: Wire route + nav**

In `web/src/App.tsx`:
- Add `import { Files } from "./views/Files";` beside the other view imports.
- In the `<Routes>` block (lines 168–175), add before the Settings route:

```tsx
<Route path="/files" element={<Files />} />
```

- In the left nav, add a NavLink directly ABOVE the existing Settings NavLink (NOT among the first three links — `App.test.tsx:71,96` asserts the first three are Daily Notes / Current Work / TODO), matching the Settings link's exact prop shape:

```tsx
<NavLink to="/files" onClick={() => setNavOpen(false)}
  className={({ isActive }) =>
    "nav-link primary" + (isActive ? " active" : "")}>
  Files
</NavLink>
```

- In `web/src/App.test.tsx`, add a routing test. Mirror the render harness the file already uses for its route tests (it stubs fetch globally and wraps in `MemoryRouter` with `ROUTER_FUTURE_FLAGS`); the body is:

```tsx
it("renders the Files view at /files", async () => {
  // use this file's existing route-test render helper with
  // initialEntries: ["/files"]
  expect(
    await screen.findByRole("heading", { name: "Files" }),
  ).toBeInTheDocument();
});
```

Assert only the heading: the suite's global fetch stub 404s `/api/assets/search`, so the view lands in its error state, which still renders the heading.

- [ ] **Step 5: Append styles**

At the END of `web/src/styles.css`:

```css
/* Files view (pkm-jdu3) */
.files-page { max-width: 1100px; }
.files-filters {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin: 12px 0; color: var(--color-text-muted);
}
.files-toolbar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin: 12px 0;
}
.files-count { color: var(--color-text-muted); font-size: 0.9em; }
.files-grid {
  display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}
.file-card {
  position: relative; display: flex; flex-direction: column; gap: 4px;
  padding: 8px; background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
}
.file-card.selected { background: var(--color-selected-bg); }
.file-thumb {
  display: flex; align-items: center; justify-content: center;
  height: 110px; overflow: hidden; border-radius: var(--radius-control);
  background: var(--color-bg-subtle);
}
.file-thumb img { width: 100%; height: 100%; object-fit: cover; }
.file-type-label {
  color: var(--color-text-muted); text-transform: uppercase;
  font-size: 0.8em; letter-spacing: 0.08em;
}
.file-name {
  font-size: 0.85em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}
.file-sub { font-size: 0.75em; color: var(--color-text-muted); }
.file-badges { display: flex; gap: 4px; }
.file-badge {
  font-size: 0.7em; padding: 1px 6px;
  border-radius: var(--radius-control);
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.file-badge.status-failed { color: var(--color-error); }
.file-badge.linked { color: var(--color-link); }
.file-select { position: absolute; top: 12px; left: 12px; }
.file-copy { align-self: flex-start; }
.files-more { margin: 12px 0; }
```

- [ ] **Step 6: Run the tests**

Run: `cd web && pnpm test:unit src/views/Files.test.tsx src/App.test.tsx`
Expected: all PASS

- [ ] **Step 7: Full web verification**

Run: `cd web && pnpm verify`
Expected: typecheck, lint, fcis check, unit coverage (95/91/89/95), build, and existing E2E all green. If coverage on `Files.tsx` falls short, add targeted tests for the uncovered branches (vitest prints them) rather than loosening thresholds. Known flakes: `lintConfig.test` and `link-reference.spec` (retry once before investigating).

- [ ] **Step 8: Commit**

```bash
git add web/src/views/Files.tsx web/src/views/Files.test.tsx web/src/App.tsx \
  web/src/App.test.tsx web/src/styles.css
git commit -m "feat(web): /files asset browser view (pkm-jdu3)"
```

---

### Task 7: End-to-end test

**Files:**
- Create: `web/e2e/files.spec.ts`

**Interfaces:**
- Consumes: the full stack from Tasks 1–6; e2e helpers `./fixtures` (custom test/expect) and `./server-state` (`waitForServerText(page, title, text)`).

- [ ] **Step 1: Write the spec**

Create `web/e2e/files.spec.ts` (check `web/e2e/edit.spec.ts:7` and `image-expansion.spec.ts:27` for the exact current login/upload idioms before writing — copy theirs if they've drifted from below):

```ts
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
  + "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// Different bytes -> different sha256 for the second asset.
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

async function login(page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function upload(page, name: string, buffer: Buffer) {
  const r = await page.request.post("/api/assets", {
    multipart: { file: { name, mimeType: "image/png", buffer } },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test("browse, orphan purge, linked delete, export", async ({ page }) => {
  await login(page);
  const title = `Files E2E ${Date.now()}`;
  const linked = await upload(page, "linked.png", PNG);
  const orphan = await upload(page, "orphan.png", PNG2);
  await page.request.post("/api/pages", { data: { title } });
  const uid = `filese2e${Date.now()}`;
  await page.request.post("/api/ops", {
    data: {
      client_id: "e2e", batch_id: `files-${uid}`,
      ops: [{ op: "create", uid, page_title: title, parent_uid: null,
              order_idx: 0, text: `diagram: ![](${linked.url})` }],
    },
  });

  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Files" }))
    .toBeVisible();
  await expect(page.getByText("linked.png")).toBeVisible();

  // Orphan copy-link (clipboard patched before click).
  await page.evaluate(() => {
    (navigator.clipboard as any).writeText = (t: string) => {
      (window as any).__copied = t;
      return Promise.resolve();
    };
  });
  const orphanCard = page.locator(".file-card",
                                  { hasText: "orphan.png" });
  await orphanCard.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => (window as any).__copied))
    .toContain(`](${orphan.url})`);

  // Orphan purge: filter -> select all -> calm delete.
  await page.getByLabel("Linked").selectOption("orphan");
  await expect(page.getByText("linked.png")).toHaveCount(0);
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/None are linked/)).toBeVisible();
  await page.getByRole("button", { name: /^Delete files?$/ }).click();
  await expect(page.getByText(/^Deleted /)).toBeVisible();
  expect((await page.request.get(orphan.url)).status()).toBe(404);

  // Linked delete goes loud, lists the page, strips the token.
  await page.getByLabel("Linked").selectOption("all");
  await page.getByLabel("Select linked.png").check();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/still linked/)).toBeVisible();
  await expect(page.getByText(new RegExp(title))).toBeVisible();
  await page.getByRole("button", { name: "Delete file" }).click();
  await expect(page.getByText(/^Deleted /)).toBeVisible();
  await waitForServerText(page, title, "diagram:");
  expect((await page.request.get(linked.url)).status()).toBe(404);
});

test("export selected downloads a zip", async ({ page }) => {
  await login(page);
  await upload(page, "export-me.png", Buffer.concat([PNG, PNG2]));
  await page.goto("/files");
  await page.getByLabel("Select export-me.png").check();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  expect(download.suggestedFilename())
    .toMatch(/^assets-\d{4}-\d{2}-\d{2}\.zip$/);
});
```

- [ ] **Step 2: Build and run the spec**

Run: `cd web && pnpm build && pnpm exec playwright test e2e/files.spec.ts`
(`pnpm e2e` serves `web/dist` — a stale dist falsely passes, so build first. If prod dev clashes on the port, `E2E_PORT=8985` — never 8974.)
Expected: both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add web/e2e/files.spec.ts
git commit -m "test(e2e): /files browse, orphan purge, delete, export (pkm-jdu3)"
```

---

### Task 8: Final verification, bean close-out, integration

**Files:**
- Modify: `.beans/pkm-jdu3--file-browser-ui-for-asset-management.md`

- [ ] **Step 1: Run everything from the repo root**

```bash
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
cd ../web && pnpm verify
```

Expected: all green, coverage gates met.

- [ ] **Step 2: Confirm generated artifacts are committed**

Run: `git status -sb`
Expected: clean tree — in particular `web/src/api/openapi.json` and `web/src/api/types.d.ts` committed in Tasks 2–4 and unchanged now.

- [ ] **Step 3: Update the bean**

In `.beans/pkm-jdu3--file-browser-ui-for-asset-management.md`: set `status: in-progress` → `completed` in the frontmatter, and append a `## Summary of Changes` section describing: extended search (type/date/linked/offset/total/describe_error), DELETE with token-strip + emptied-leaf-block cleanup, form-POST export.zip, the `/files` grid view, and the e2e spec. Note the pkm-t5pu carry-overs landed (referencing_blocks type, render test assert, FTS-delete pin).

```bash
git add .beans/pkm-jdu3--file-browser-ui-for-asset-management.md
git commit -m "chore(beans): complete pkm-jdu3 file browser"
```

- [ ] **Step 4: Integrate**

Invoke superpowers:finishing-a-development-branch to choose merge/PR/cleanup (repo convention: `git merge --no-ff`). Deployment is a separate, user-initiated step (`~/.config/pkm/app/deploy/update.sh` — never the dev checkout's copy).
