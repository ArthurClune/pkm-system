# pkm-t5pu: Asset Search Refs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/assets/search` returns, for every hit, the complete list of blocks referencing the asset (`uid` + `page_title`), rendered by `render_assets` so the assistant/CLI can cite `((uid))` and page titles from a single call.

**Architecture:** A standalone `referencing_blocks(db, sha256)` helper in `routes_assets.py` runs one FTS5 exact-token lookup per returned asset (`blocks_fts MATCH phrase_query(sha)` — the unicode61 tokenizer keeps a 64-hex sha as one token). The route attaches the result as `refs`; `render_assets` prints one `in [[title]] ((uid))` line per ref. Uncapped by design — silent truncation was explicitly rejected.

**Tech Stack:** FastAPI + sqlite FTS5 (server), Pydantic response models, pytest; generated `openapi.json`/`types.d.ts` must be regenerated in the same commit as the schema change (`test_openapi_sync.py` enforces this).

**Spec:** `docs/superpowers/specs/2026-07-28-pkm-t5pu-asset-refs-design.md`

## Global Constraints

- Run all server commands from `server/`: `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`. Web: from `web/`: `pnpm typecheck`.
- Regenerate API types after any response-model change: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `cd web && pnpm gen-types`; commit both generated files with the model change, or `test_openapi_sync.py` fails.
- FCIS: `routes_assets.py` is `# pattern: Imperative Shell`; `cli/render.py` is `# pattern: Functional Core`. Don't change the annotations.
- Work happens in the dedicated worktree/branch for pkm-t5pu; run everything from the worktree root, never the main checkout. Check `git status -sb` before every commit.
- Commit the bean file `.beans/pkm-t5pu--*.md` together with code changes.
- `refs` is UNCAPPED — do not add a limit, cap, or count field.

---

### Task 1: Server — `referencing_blocks` helper, `refs` in search payload, regen

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py` (search route at ~line 55)
- Modify: `server/src/pkm/server/response_models.py` (~line 161, `AssetSearchItem`)
- Create: `server/tests/test_asset_refs.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

**Interfaces:**
- Consumes: `phrase_query(q: str) -> str` from `pkm.server.fts`; existing fixtures `client`, `seeded_config` from `server/tests/conftest.py` (seed pages include "AI" and "Machine Learning"; login already done in `client`).
- Produces: `referencing_blocks(db: sqlite3.Connection, sha256: str) -> list[dict]` in `pkm.server.routes_assets` — each dict `{"uid": str, "page_title": str}`, ordered by `(page_title, uid)`. Every item in the `/api/assets/search` response gains `refs: list[{uid, page_title}]`. pkm-jdu3 will import this helper later; keep it module-level and route-independent.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_asset_refs.py`:

```python
"""GET /api/assets/search returns referencing blocks (pkm-t5pu)."""
import hashlib


def _upload(client, content=b"PNGDATA", name="pic.png"):
    r = client.post("/api/assets",
                    files={"file": (name, content, "image/png")})
    assert r.status_code == 200
    return r.json()


def _create_block(client, uid, page_title, text, order_idx=10):
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": f"batch-{uid}",
        "ops": [{"op": "create", "uid": uid, "page_title": page_title,
                 "parent_uid": None, "order_idx": order_idx, "text": text}]})
    assert r.status_code == 200, r.text


def _search_hit(client, sha):
    hits = client.get("/api/assets/search",
                      params={"q": ""}).json()["assets"]
    return next(h for h in hits if h["sha256"] == sha)


def test_referenced_asset_carries_refs(client):
    asset = _upload(client)
    _create_block(client, "refblk1", "AI",
                  f"diagram: ![]({asset['url']})")
    hit = _search_hit(client, asset["sha256"])
    assert hit["refs"] == [{"uid": "refblk1", "page_title": "AI"}]


def test_unreferenced_asset_has_empty_refs(client):
    asset = _upload(client)
    assert _search_hit(client, asset["sha256"])["refs"] == []


def test_refs_ordered_by_page_title_then_uid(client):
    asset = _upload(client)
    url = asset["url"]
    # insertion order deliberately scrambled vs expected output order
    _create_block(client, "zz_last", "AI", f"see ![]({url})", order_idx=11)
    _create_block(client, "aa_first", "AI", f"also ![]({url})", order_idx=12)
    _create_block(client, "mlblk", "Machine Learning", f"![]({url})")
    hit = _search_hit(client, asset["sha256"])
    assert hit["refs"] == [
        {"uid": "aa_first", "page_title": "AI"},
        {"uid": "zz_last", "page_title": "AI"},
        {"uid": "mlblk", "page_title": "Machine Learning"},
    ]


def test_refs_uncapped_beyond_a_handful(client):
    asset = _upload(client)
    for i in range(8):
        _create_block(client, f"many{i:02d}", "AI",
                      f"copy {i}: ![]({asset['url']})", order_idx=20 + i)
    hit = _search_hit(client, asset["sha256"])
    assert len(hit["refs"]) == 8
```

Notes for the implementer:
- The block text embeds the full `/assets/<sha>/<filename>` URL — this is
  the load-bearing tokenizer assumption (sha found inside a URL), so the
  tests exercise it directly.
- `/api/ops` create ops fire the `blocks_fts_ai` trigger, so FTS stays in
  sync via the real write path; do not insert blocks with raw SQL.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_refs.py -q`
Expected: 4 failures — `KeyError: 'refs'` (route doesn't return the field yet).

- [ ] **Step 3: Implement helper + route + model**

In `server/src/pkm/server/response_models.py`, above `AssetSearchItem`:

```python
class AssetRef(BaseModel):
    uid: str
    page_title: str
```

and add to `AssetSearchItem` (after `status`):

```python
    refs: list[AssetRef]
```

In `server/src/pkm/server/routes_assets.py`: import `phrase_query` from
`pkm.server.fts` and `AssetRef` is NOT needed (route returns dicts). Add
the helper above the search route:

```python
def referencing_blocks(db: sqlite3.Connection, sha256: str) -> list[dict]:
    """All blocks whose text contains the asset's sha, with their page
    titles. FTS5 unicode61 keeps a 64-hex sha as one token, so an
    exact-phrase MATCH on the sha finds every block embedding the
    /assets/<sha>/<filename> URL (same trick pkm-gdi5 uses client-side).
    Uncapped: shared with pkm-jdu3's delete-warning/orphan checks, which
    need the complete list."""
    rows = db.execute(
        """SELECT b.uid, p.title AS page_title
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             JOIN pages p ON p.id = b.page_id
            WHERE blocks_fts MATCH ?
            ORDER BY p.title, b.uid""",
        (phrase_query(sha256),)).fetchall()
    return [{"uid": r["uid"], "page_title": r["page_title"]} for r in rows]
```

In the `search_assets` route's return, add per asset:

```python
        "refs": referencing_blocks(db, r["sha256"]),
```

- [ ] **Step 4: Run the new tests, then the full suite**

Run: `cd server && uv run pytest tests/test_asset_refs.py -q`
Expected: 4 passed.

Run: `cd server && uv run pytest -q`
Expected: everything passes EXCEPT `test_openapi_sync.py` (committed
`openapi.json` is now stale) — that's the next step. If anything else
fails, stop and investigate.

- [ ] **Step 5: Regenerate openapi.json + web types**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

- [ ] **Step 6: Verify green**

Run: `cd server && uv run pytest -q` — Expected: all pass, coverage gate met.
Run: `cd server && uv run pyrefly check` — Expected: no errors.
Run: `cd server && uv run ruff check` — Expected: no errors.
Run: `cd web && pnpm typecheck` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git status -sb   # confirm you're on the pkm-t5pu branch in the worktree
git add server/src/pkm/server/routes_assets.py \
        server/src/pkm/server/response_models.py \
        server/tests/test_asset_refs.py \
        web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "feat(server): asset search returns referencing blocks (pkm-t5pu)"
```

---

### Task 2: Rendering + MCP docstring — surface refs to the assistant/CLI

**Files:**
- Modify: `server/src/pkm/cli/render.py:114-127` (`render_assets`)
- Modify: `server/src/pkm/mcp/server.py:160-165` (`search_assets` docstring)
- Test: `server/tests/test_cli_render.py` (extend existing render_assets tests)

**Interfaces:**
- Consumes: search payload items now carry `refs: list[{uid, page_title}]` (Task 1). Use `a.get("refs")` defensively — the CLI may talk to an older server whose payload lacks the field.
- Produces: `render_assets` output gains one line per ref, exactly `  in [[<page_title>]] ((<uid>))`, after the description line (or after the URL line when there is no description). MCP tool docstring documents the refs so the model cites without a `get_page` round-trip.

- [ ] **Step 1: Extend the render tests (failing first)**

In `server/tests/test_cli_render.py`, update `test_render_assets`: add
`"refs"` to both payload items and assert the ref lines:

```python
def test_render_assets():
    payload = {"assets": [
        {"sha256": "ab" * 32, "filename": "graph.png", "mime": "image/png",
         "size": 1234, "created_at": 1753500000000,
         "url": "/assets/" + "ab" * 32 + "/graph.png",
         "description": "a bar chart of revenue", "status": "described",
         "refs": [{"uid": "u1", "page_title": "Holiday 2026"},
                  {"uid": "u2", "page_title": "July 26th, 2026"}]},
        {"sha256": "cd" * 32, "filename": "raw.png", "mime": "image/png",
         "size": 99, "created_at": None,
         "url": "/assets/" + "cd" * 32 + "/raw.png",
         "description": None, "status": "pending", "refs": []},
    ]}
    out = render_assets(payload)
    assert "graph.png" in out
    assert "a bar chart of revenue" in out
    assert "/assets/" + "ab" * 32 + "/graph.png" in out
    assert "pending" in out
    assert "  in [[Holiday 2026]] ((u1))" in out
    assert "  in [[July 26th, 2026]] ((u2))" in out
    # unreferenced asset gets no "in [[" line (its ref lines would come
    # after its URL line, i.e. after the LAST "raw.png" occurrence)
    assert "in [[" not in out.split("raw.png")[-1]


def test_render_assets_tolerates_missing_refs_key():
    payload = {"assets": [
        {"sha256": "ef" * 32, "filename": "old.png", "mime": "image/png",
         "size": 1, "created_at": None,
         "url": "/assets/" + "ef" * 32 + "/old.png",
         "description": None, "status": "pending"}]}
    assert "old.png" in render_assets(payload)
```

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `cd server && uv run pytest tests/test_cli_render.py -q`
Expected: `test_render_assets` FAILS on the `in [[...]]` assertions;
`test_render_assets_tolerates_missing_refs_key` passes already (that's
fine — it pins behaviour we must not break).

- [ ] **Step 3: Implement**

In `render_assets` (`server/src/pkm/cli/render.py`), after the
description append:

```python
        for ref in a.get("refs") or []:
            lines.append(f"  in [[{ref['page_title']}]] (({ref['uid']}))")
```

Update the function docstring's first line to mention refs, e.g.
`"""One asset per block: filename, url, status, description, then one
'in [[page]] ((uid))' line per referencing block."""`

In `server/src/pkm/mcp/server.py`, replace the `search_assets` docstring:

```python
def search_assets(q: str, limit: int = 20) -> str:
    """Find uploaded images/files by LLM-generated image description or
    filename. Returns filename, status, a /assets/... URL embeddable in a
    block as ![](url), the description, and every block referencing the
    asset as 'in [[page title]] ((uid))' — cite those directly instead of
    searching for the asset's page with get_page. Images are described
    automatically after upload when the feature is enabled."""
    return render_assets(_client().search_assets(q, limit=limit))
```

- [ ] **Step 4: Run the tests**

Run: `cd server && uv run pytest tests/test_cli_render.py -q`
Expected: all pass.

- [ ] **Step 5: Full verification**

Run: `cd server && uv run pytest -q` — all pass.
Run: `cd server && uv run pyrefly check` — no errors.
Run: `cd server && uv run ruff check` — no errors.

- [ ] **Step 6: Update the bean and commit**

Mark progress in `.beans/pkm-t5pu--*.md` (check off done items). Then:

```bash
git status -sb   # confirm branch
git add server/src/pkm/cli/render.py server/src/pkm/mcp/server.py \
        server/tests/test_cli_render.py .beans/
git commit -m "feat(cli,mcp): render asset refs, teach search_assets docstring (pkm-t5pu)"
```

---

### Out of scope (do not do)

- No web UI change; `types.d.ts` is regenerated but unused until pkm-jdu3.
- No pagination/caps/counts on `refs`.
- No `SYSTEM_PROMPT` change in `assistant/policy.py` — the "ten PKM verbs"
  drift named in the bean was already fixed by pkm-hjcc; verify with
  `grep -n "ten" server/src/pkm/assistant/policy.py` (expect no match) and
  note it in the bean's Summary of Changes.
