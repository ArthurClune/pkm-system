# Frontend Read Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The read half of the PKM frontend: a React + TypeScript + Vite app (new `web/` directory) that renders the graph — block outlines with Roam-flavoured markdown, page view with backlinks and unlinked references, daily-notes journal home with infinite scroll, Cmd-K search, live `{{[[query]]}}` blocks, and a shift-click right sidebar stack — plus the server serving the built SPA. NO editing, no phone composer, no WebSocket consumption (all plan 5). Phone gets the same responsive app, view-only.

**Architecture:** A pure TS grammar core (`web/src/grammar/`) tokenizes stored block text into typed segments and extracts refs, pinned to the same shared fixture as the Python parser; presentational components render segments; thin imperative-shell views fetch the read API and own state. The FastAPI server is the contract — response shapes are consumed as-is (no API semantics change); it additionally gains an optional `web_dist` config to serve the built SPA with a catch-all index.html route. Spec: `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` Sections 1, 3, 4. **This is plan 4 of 6** (import ✅ → read API ✅ → write path/sync ✅ → frontend read → frontend edit → deployment).

**Tech Stack:** pnpm, Vite, React 18, TypeScript (strict), react-router-dom v6, highlight.js, openapi-typescript (dev). Tests: vitest + @testing-library/react + jsdom. Server side: existing Python ≥3.12 / FastAPI stack via `uv`.

## Global Constraints

- All web commands run from `web/` via pnpm; vitest non-watch runs are `pnpm test -- --run`; `pnpm typecheck` (strict tsc) must pass before every web commit.
- All server commands run from `server/` via `uv run …`.
- FCIS headers in both languages: every runtime `.py` file keeps and every runtime `.ts`/`.tsx` file gains `# pattern: …` / `// pattern: Functional Core` or `// pattern: Imperative Shell` near the top. Components that only render props are Functional Core; anything fetching/routing/DOM-side-effecting is Imperative Shell. Tests, configs, and type-only files are exempt.
- TypeScript strict mode; no `any` (tests may use `as unknown as T` bridges where jsdom typing forces it).
- The UI never renders unbounded lists: backlinks, unlinked refs, query results paginate with "show more"; the journal loads a few days at a time.
- FTS `<mark>` snippets are rendered by splitting on the literal tags — NEVER `dangerouslySetInnerHTML` for server text. (Sole sanctioned exception: highlight.js output in CodeBlock, which is library-generated from escaped input.)
- The server API is the contract: do not change response shapes or route semantics. `GET /api/page/{title}` uses path-typed titles — encode per segment so `/` stays literal.
- Never commit `data/` or `sample-data/`; `web/node_modules/` and `web/dist/` are gitignored; the two generated files `web/src/api/openapi.json` and `web/src/api/types.d.ts` ARE committed.
- Commit after each green test cycle; push after committing. End commit messages with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN
```

## File Structure

```
web/                              # new top-level directory (pnpm workspace-free, standalone)
  package.json  pnpm-lock.yaml  .gitignore  index.html
  vite.config.ts  tsconfig.json                                    [T2]
  src/
    main.tsx            # IS: entry — BrowserRouter + root render  [T2]
    App.tsx             # IS: shell, nav, routes                   [T2; rewritten T6, T8, T9, T11]
    styles.css          # single plain-CSS theme (appended T6–T11) [T2+]
    test-setup.ts       # vitest setup: jest-dom + RTL cleanup     [T2]
    test-helpers.ts     # fetch stub + payload factories (tests)   [T6]
    contexts.ts         # FC: SidebarContext, BlockRefContext      [T4]
    paths.ts            # FC: encodeTitle, pagePath, titleFromPathname [T4]
    api/
      openapi.json      # generated dump (committed)               [T2]
      types.d.ts        # openapi-typescript output (committed)    [T2]
      client.ts         # IS: apiFetch — JSON in/out, 401 → /login [T2]
      payloads.ts       # type-only: response payload interfaces   [T2]
    grammar/
      refs.ts           # FC: ref extraction, mirrors pkm/refs.py  [T3]
      tokenize.ts       # FC: block text → typed render segments   [T3]
      snippet.ts        # FC: parse FTS <mark> snippets            [T9]
    components/
      PageLink.tsx  InlineSegments.tsx  CodeBlock.tsx  AssetImage.tsx
      PdfEmbed.tsx  BlockRef.tsx  TodoCheckbox.tsx                 [T4]
      BlockTree.tsx                                                [T5]
      groups.ts  BacklinksSection.tsx  UnlinkedSection.tsx         [T7]
      SearchModal.tsx                                              [T9]
      QueryBlock.tsx                                               [T10]
      SidebarPanel.tsx                                             [T11]
    views/
      PageView.tsx                                                 [T6; extended T7]
      Journal.tsx                                                  [T8]
server/src/pkm/server/
  openapi_dump.py       # IS: print app.openapi() JSON             [T1 new]
  ops_core.py ops_apply.py auth_core.py ws.py                      [T1 modify]
  config.py setup.py app.py    # web_dist + SPA serving            [T12 modify]
server/tests/
  test_preflight.py                                                [T1 new]
  test_ops_core.py test_ws.py                                      [T1 modify]
  test_spa.py                                                      [T12 new]
```

---

### Task 1: Server pre-flight — plan-3 review carryovers + OpenAPI dump entrypoint

The deferred cleanups from plan 3's final review (spec: "Write-path API contract notes"), plus a new `openapi_dump` module so Task 2 can generate TS types from the schema without a running server.

**Files:**
- Create: `server/src/pkm/server/openapi_dump.py`, `server/tests/test_preflight.py`
- Modify: `server/tests/test_ops_core.py` (drop unused `TypeAdapter` import), `server/src/pkm/server/ops_apply.py` (explicit `TouchPage` arm), `server/src/pkm/server/auth_core.py` (`.isascii()` guard), `server/src/pkm/server/ws.py` (`finally:` disconnect), `server/src/pkm/server/ops_core.py` (`CreateOp.heading` bounds), `server/tests/test_ws.py` (assert close code 4401)

**Interfaces:**
- Consumes: `create_app` (app.py), `Config` (config.py), existing op models/tests.
- Produces:
  - `python -m pkm.server.openapi_dump` → prints `json.dumps(app.openapi(), indent=2)` for an app built from a dummy Config (hex-string placeholders; no DB touched). `openapi_dump.main() -> int` for tests.
  - `CreateOp.heading: int | None = Field(default=None, ge=1, le=3)` — out-of-range heading now 422s at the endpoint.
  - `verify_session` rejects non-ASCII "digit" timestamps.
  - `ws_endpoint` always deregisters from the hub (`finally:`), even on non-disconnect exceptions.

- [ ] **Step 1: Write the failing tests**

`server/tests/test_preflight.py`:
```python
import json

from pkm.server import openapi_dump
from pkm.server.auth_core import sign_session, verify_session

SECRET = b"s" * 32
NOW = 1_700_000_000_000


def test_non_ascii_digit_timestamp_rejected():
    # Arabic-Indic digits pass str.isdigit() (and int()) but must not pass
    # session verification.
    sig = sign_session(SECRET, NOW).split(".")[2]
    assert not verify_session(SECRET, f"v1.١٢٣.{sig}", now_ms=NOW)


def test_create_heading_bounds(client):
    def create(heading):
        return client.post("/api/ops", json={"client_id": "c1", "ops": [
            {"op": "create", "uid": "newuid7",
             "page_title": "Machine Learning", "parent_uid": None,
             "order_idx": 5, "text": "h", "heading": heading}]})
    assert create(4).status_code == 422
    assert create(0).status_code == 422
    assert create(3).status_code == 200


def test_openapi_dump_prints_schema(capsys):
    assert openapi_dump.main() == 0
    schema = json.loads(capsys.readouterr().out)
    assert "/api/ops" in schema["paths"]
    assert "/api/page/{title}" in schema["paths"]
    assert "OpBatch" in schema["components"]["schemas"]
```

In `server/tests/test_ws.py`, replace `test_ws_requires_auth` with a version that pins the close code:
```python
def test_ws_requires_auth(anon_client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with anon_client.websocket_connect("/api/ws") as ws:
            ws.receive_text()
    assert exc.value.code == 4401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_preflight.py tests/test_ws.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.openapi_dump'`; `test_non_ascii_digit_timestamp_rejected` fails (unicode digits currently accepted); `test_create_heading_bounds` fails (heading=4 returns 200, not 422). `test_ws_requires_auth` should already pass (close code was 4401 all along) — the change just pins it.

- [ ] **Step 3: Implement**

`server/src/pkm/server/openapi_dump.py`:
```python
# pattern: Imperative Shell
"""Dump the OpenAPI schema for TS type generation:
python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
Builds a throwaway app from a dummy Config; touches no database."""
from __future__ import annotations

import json
from pathlib import Path

from pkm.server.app import create_app
from pkm.server.config import Config


def main() -> int:
    config = Config(
        db_path=Path("/nonexistent/pkm.sqlite3"),
        assets_dir=Path("/nonexistent/assets"),
        password_salt="00" * 16,   # dummy hex — Config fields must parse as hex
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    print(json.dumps(create_app(config).openapi(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`server/src/pkm/server/auth_core.py` — in `verify_session`, extend the parts guard (`.isascii()` beside `isdigit()`):
```python
    if (len(parts) != 3 or parts[0] != "v1"
            or not parts[1].isascii() or not parts[1].isdigit()):
        return False
```

`server/src/pkm/server/ops_core.py` — `CreateOp.heading` gains bounds (Field is already imported):
```python
    heading: int | None = Field(default=None, ge=1, le=3)
```

`server/src/pkm/server/ops_apply.py` — in `_execute`, replace the trailing bare `else:` arm:
```python
    elif isinstance(eff, TouchPage):
        db.execute("UPDATE pages SET updated_at = ? WHERE id = ?",
                   (now_ms, eff.page_id))
    else:
        raise AssertionError(f"unhandled effect: {eff!r}")
```
(`TouchPage` is already imported; this makes the import load-bearing instead of comment-only.)

`server/src/pkm/server/ws.py` — in `ws_endpoint`, make disconnect unconditional:
```python
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # inbound is ignored (keepalive)
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(websocket)
```

`server/tests/test_ops_core.py` — first import line becomes:
```python
from pydantic import ValidationError
```
(`TypeAdapter` was never used.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_preflight.py tests/test_ws.py tests/test_ops_core.py tests/test_ops_endpoint.py tests/test_auth.py -v`
Expected: all PASS. Full suite: `uv run pytest -q` → all pass.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "chore: plan-3 review carryovers and openapi dump entrypoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 2: Web scaffold — Vite + React + TS strict, generated API types, `apiFetch`

**Files:**
- Create: `web/package.json` (via pnpm), `web/.gitignore`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/test-setup.ts`, `web/src/api/client.ts`, `web/src/api/payloads.ts`, `web/src/api/openapi.json` (generated), `web/src/api/types.d.ts` (generated)
- Test: `web/src/api/client.test.ts`

**Interfaces:**
- Consumes: `python -m pkm.server.openapi_dump` (Task 1); the read API's response shapes (routes_pages.py / routes_search.py — copied into `payloads.ts` verbatim as types).
- Produces (every later task consumes):
  - `apiFetch<T>(path: string, init?: RequestInit): Promise<T>` — JSON out; 401 → login redirect + throw; non-2xx → throws `ApiError` (`.status: number`)
  - `setUnauthorizedHandler(handler: () => void): void` + `defaultUnauthorizedHandler()` (assigns `window.location.href = "/login"`; injectable because jsdom's `location` is unforgeable and tests need a spy)
  - `payloads.ts` types: `PageMeta`, `BlockNode`, `BacklinkItem`, `BacklinkGroup`, `Backlinks`, `BlockRefText`, `PagePayload`, `GroupItem`, `BlockGroup`, `GroupsPayload`, `JournalDay`, `JournalPayload`, `SearchPageHit`, `SearchBlockHit`, `SearchPayload`
  - Dev proxy: `/api`, `/assets`, `/login` → `http://127.0.0.1:8974`; `build.assetsDir = "app-assets"`, `base = "/"`
  - Scripts: `pnpm dev`, `pnpm build` (tsc + vite build), `pnpm test`, `pnpm typecheck`, `pnpm gen-types`

- [ ] **Step 1: Scaffold directory, install dependencies**

```bash
mkdir -p web/src/api
cd web && cat > package.json <<'JSON'
{
  "name": "pkm-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest",
    "typecheck": "tsc",
    "gen-types": "openapi-typescript src/api/openapi.json -o src/api/types.d.ts"
  }
}
JSON
pnpm add react@^18.3.1 react-dom@^18.3.1 react-router-dom@^6.30.0 highlight.js@^11
pnpm add -D typescript@^5.6 vite@^6 @vitejs/plugin-react@^4 vitest@^3 jsdom@^26 \
  @testing-library/react@^16 @testing-library/jest-dom@^6 \
  @types/react@^18 @types/react-dom@^18 openapi-typescript@^7
```

`web/.gitignore`:
```
node_modules/
dist/
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src"]
}
```

`web/vite.config.ts` (vitest config merged in; no FCIS header — config file):
```typescript
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { assetsDir: "app-assets" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8974",
      "/assets": "http://127.0.0.1:8974",
      "/login": "http://127.0.0.1:8974",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    globals: false,
  },
});
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pkm</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/test-setup.ts`:
```typescript
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);
```

`web/src/main.tsx` (final form — later tasks only change App):
```tsx
// pattern: Imperative Shell
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`web/src/App.tsx` (placeholder shell; Task 6 replaces it):
```tsx
// pattern: Imperative Shell
export function App() {
  return <p>pkm</p>;
}
```

`web/src/styles.css` (base; Tasks 6–11 append sections):
```css
/* pkm — Roam-ish light theme. Plain CSS only. */
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: #202b33;
  background: #ffffff;
}
a { color: #106ba3; text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; }
```

`web/src/api/payloads.ts` (type-only — exempt from FCIS header; shapes copied from routes_pages.py / routes_search.py, which return untyped dicts, so openapi-typescript cannot generate them):
```typescript
// Response payload shapes for the read API. These mirror the server's dict
// responses (routes_pages.py, routes_search.py) — the OpenAPI schema only
// carries request models (see src/api/types.d.ts), so responses are pinned
// here by hand and exercised by tests using fixture payloads of this shape.

export interface PageMeta {
  id: number;
  title: string;
  created_at: number | null;
  updated_at: number | null;
}

export interface BlockNode {
  uid: string;
  text: string;
  heading: number | null;
  collapsed: boolean;
  created_at: number | null;
  updated_at: number | null;
  children: BlockNode[];
}

export interface BacklinkItem {
  uid: string;
  text: string;
  breadcrumbs: string[];
}

export interface BacklinkGroup {
  page_id: number;
  page_title: string;
  items: BacklinkItem[];
}

export interface Backlinks {
  groups: BacklinkGroup[];
  total_pages: number;
  offset: number;
  limit: number;
}

export interface BlockRefText {
  text: string;
  page_title: string;
}

export interface PagePayload {
  page: PageMeta;
  blocks: BlockNode[];
  backlinks: Backlinks;
  block_ref_texts: Record<string, BlockRefText>;
}

/** Shared by /api/unlinked and /api/query (both return {groups, total}). */
export interface GroupItem {
  uid: string;
  text: string;
}

export interface BlockGroup {
  page_id: number;
  page_title: string;
  items: GroupItem[];
}

export interface GroupsPayload {
  groups: BlockGroup[];
  total: number;
}

export interface JournalDay {
  date: string;   // ISO yyyy-mm-dd
  title: string;  // Roam ordinal title, e.g. "July 8th, 2026"
  exists: boolean;
  blocks: BlockNode[];
}

export interface JournalPayload {
  days: JournalDay[];
}

export interface SearchPageHit {
  id: number;
  title: string;
}

export interface SearchBlockHit {
  uid: string;
  page_title: string;
  snippet: string; // contains literal <mark>…</mark> from FTS5
}

export interface SearchPayload {
  pages: SearchPageHit[];
  blocks: SearchBlockHit[];
}
```

- [ ] **Step 2: Generate the OpenAPI dump and TS types (both committed)**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
git add -f web/src/api/openapi.json web/src/api/types.d.ts   # generated but committed
```

Expected: `web/src/api/types.d.ts` exists and contains `OpBatch` / `CreateOp` component schemas (used by plan 5's editor; committed now so the two generated files version together).

- [ ] **Step 3: Write the failing test for apiFetch**

`web/src/api/client.test.ts`:
```typescript
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, apiFetch, defaultUnauthorizedHandler, setUnauthorizedHandler } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(defaultUnauthorizedHandler);
});

it("returns parsed json", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(apiFetch<{ ok: boolean }>("/api/x")).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledWith("/api/x", undefined);
});

it("invokes the unauthorized handler and throws on 401", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "no" }, 401)));
  const redirect = vi.fn();
  setUnauthorizedHandler(redirect);
  await expect(apiFetch("/api/x")).rejects.toThrow("401");
  expect(redirect).toHaveBeenCalledOnce();
});

it("throws ApiError carrying the status on other failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "nope" }, 404)));
  const err = await apiFetch("/api/x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(404);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run`
Expected: FAIL — `Cannot find module './client'` (or "Failed to resolve import").

- [ ] **Step 5: Implement apiFetch**

`web/src/api/client.ts`:
```typescript
// pattern: Imperative Shell
// Thin fetch wrapper: JSON in/out; 401 -> login redirect.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`request failed: ${status} ${path}`);
    this.status = status;
  }
}

export function defaultUnauthorizedHandler(): void {
  window.location.href = "/login";
}

let onUnauthorized: () => void = defaultUnauthorizedHandler;

/** jsdom's location is unforgeable, so tests inject a spy here;
 * the app keeps the default redirect. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, path);
  }
  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return (await res.json()) as T;
}
```

- [ ] **Step 6: Run tests, typecheck, and build to verify**

Run: `cd web && pnpm test -- --run && pnpm typecheck && pnpm build`
Expected: 3 tests PASS; tsc clean; `dist/index.html` and `dist/app-assets/*.js` produced (confirms `assetsDir`).

- [ ] **Step 7: Commit and push**

```bash
git add web/ && git commit -m "feat: web scaffold, generated api types, apiFetch wrapper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

Dev-workflow note (no action): local development runs `uv run python -m pkm.server.setup --data-dir <dev-data> --password … --insecure-cookie` once, then `uv run python -m pkm.server.run --data-dir <dev-data>` beside `pnpm dev`; the Vite proxy forwards `/api`, `/assets`, `/login`, and the insecure cookie makes the session work over plain http.

---

### Task 3: TS grammar core — ref extraction (fixture-pinned) + render tokenizer

Two pure modules. `refs.ts` mirrors `server/src/pkm/refs.py` semantics EXACTLY and must pass every case in `shared/fixtures/ref_grammar.json`. `tokenize.ts` turns block text into typed segments for rendering (a superset concern: it also handles constructs refs.py ignores, like bold/images/TODO).

**Files:**
- Create: `web/src/grammar/refs.ts`, `web/src/grammar/tokenize.ts`
- Test: `web/src/grammar/refs.test.ts`, `web/src/grammar/tokenize.test.ts`

**Interfaces:**
- Consumes: `shared/fixtures/ref_grammar.json` (read via `node:fs` in the test — the fixture lives outside the Vite root).
- Produces (Tasks 4–11 consume; names are load-bearing):
  - `refs.ts`: `RefKind = "link" | "tag" | "attribute"`, `Ref { title, kind }`, `ParsedRefs { refs: Ref[]; block_refs: string[]; embeds: number }`, `extractRefs(text: string): ParsedRefs`
  - `tokenize.ts`:
    - `EmphasisKind = "bold" | "italic" | "strike" | "highlight"`
    - `InlineSegment` union: `{kind:"text"; text}`, `{kind:"linebreak"}`, `{kind:"inline-code"; code}`, `{kind:"page-ref"; title; tag: boolean}`, `{kind:"attribute"; name}`, `{kind:"block-ref"; uid}`, `{kind:"image"; alt; src}`, `{kind:"link"; text; href}`, `{kind: EmphasisKind; children: InlineSegment[]}`
    - `BlockSegment = InlineSegment | {kind:"todo"; done: boolean} | {kind:"code-block"; lang: string | null; code: string} | {kind:"query"; expr: string}`
    - `tokenizeBlock(text: string): BlockSegment[]`

Python-parity notes baked into the code: code is stripped/skipped first; attribute matches only at the start of the block text (Python uses `re.match`); `#tag` requires start-of-text/whitespace/`(` before the `#`; the tag charset mirrors Python's unicode-aware `\w` as `[\p{L}\p{N}_./\-]`; nested `[[…]]` yields outer then inner; refs dedupe by (title, kind); block-ref uid is `[a-zA-Z0-9_-]{6,}`.

- [ ] **Step 1: Write the failing tests**

`web/src/grammar/refs.test.ts`:
```typescript
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRefs } from "./refs";

interface FixtureCase {
  name: string;
  text: string;
  refs: { title: string; kind: string }[];
  block_refs: string[];
  embeds: number;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../../shared/fixtures/ref_grammar.json", import.meta.url),
  "utf-8",
)) as { cases: FixtureCase[] };

describe("ref grammar fixture (pinned against the Python parser)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const got = extractRefs(c.text);
      expect(got.refs).toEqual(c.refs);           // order-sensitive on purpose
      expect(got.block_refs).toEqual(c.block_refs);
      expect(got.embeds).toEqual(c.embeds);
    });
  }
});
```

`web/src/grammar/tokenize.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { tokenizeBlock } from "./tokenize";

describe("tokenizeBlock", () => {
  it("parses page refs, tags and block refs around plain text", () => {
    expect(tokenizeBlock("read [[Machine Learning]] #AI ((abc123XYZ))")).toEqual([
      { kind: "text", text: "read " },
      { kind: "page-ref", title: "Machine Learning", tag: false },
      { kind: "text", text: " " },
      { kind: "page-ref", title: "AI", tag: true },
      { kind: "text", text: " " },
      { kind: "block-ref", uid: "abc123XYZ" },
    ]);
  });

  it("keeps the full outer title for nested page refs", () => {
    expect(tokenizeBlock("see [[AI [[GPT-3]] notes]]")).toEqual([
      { kind: "text", text: "see " },
      { kind: "page-ref", title: "AI [[GPT-3]] notes", tag: false },
    ]);
  });

  it("parses #[[long tags]] and requires whitespace/( before #", () => {
    expect(tokenizeBlock("#[[Generative Models]]")).toEqual([
      { kind: "page-ref", title: "Generative Models", tag: true },
    ]);
    expect(tokenizeBlock("https://example.com/#anchor")).toEqual([
      { kind: "text", text: "https://example.com/#anchor" },
    ]);
  });

  it("parses an attribute only at the start of the block", () => {
    expect(tokenizeBlock("Tags:: #AI")).toEqual([
      { kind: "attribute", name: "Tags" },
      { kind: "text", text: " " },
      { kind: "page-ref", title: "AI", tag: true },
    ]);
    // brackets in the prefix disqualify it, matching the Python char class
    expect(tokenizeBlock("a [[B]] c:: d")).toEqual([
      { kind: "text", text: "a " },
      { kind: "page-ref", title: "B", tag: false },
      { kind: "text", text: " c:: d" },
    ]);
  });

  it("does not scan inside inline code", () => {
    expect(tokenizeBlock("run `[[not a ref]]` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "inline-code", code: "[[not a ref]]" },
      { kind: "text", text: " now" },
    ]);
  });

  it("parses code fences with an optional language tag", () => {
    expect(tokenizeBlock("```python\nx = 1\n```")).toEqual([
      { kind: "code-block", lang: "python", code: "x = 1" },
    ]);
    expect(tokenizeBlock("```\nplain\n```")).toEqual([
      { kind: "code-block", lang: null, code: "plain" },
    ]);
  });

  it("parses emphasis with nested inline constructs", () => {
    expect(tokenizeBlock("**very [[Deep]]** __it__ ~~st~~ ^^hl^^")).toEqual([
      { kind: "bold", children: [
        { kind: "text", text: "very " },
        { kind: "page-ref", title: "Deep", tag: false },
      ] },
      { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "it" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "st" }] },
      { kind: "text", text: " " },
      { kind: "highlight", children: [{ kind: "text", text: "hl" }] },
    ]);
  });

  it("parses images and markdown links", () => {
    expect(tokenizeBlock("![shot](/assets/ab12/pic.png) [paper](https://x.org/a.pdf)")).toEqual([
      { kind: "image", alt: "shot", src: "/assets/ab12/pic.png" },
      { kind: "text", text: " " },
      { kind: "link", text: "paper", href: "https://x.org/a.pdf" },
    ]);
  });

  it("parses TODO/DONE prefixes as read-only checkboxes", () => {
    expect(tokenizeBlock("{{[[TODO]]}} buy milk")).toEqual([
      { kind: "todo", done: false },
      { kind: "text", text: "buy milk" },
    ]);
    expect(tokenizeBlock("{{[[DONE]]}} shipped")).toEqual([
      { kind: "todo", done: true },
      { kind: "text", text: "shipped" },
    ]);
    expect(tokenizeBlock("{{TODO}} short form")).toEqual([
      { kind: "todo", done: false },
      { kind: "text", text: "short form" },
    ]);
  });

  it("grabs query expressions with a balanced-brace scan", () => {
    expect(tokenizeBlock("{{[[query]]: {and: [[Paper]] [[Link]]}}}")).toEqual([
      { kind: "query", expr: "{and: [[Paper]] [[Link]]}" },
    ]);
    expect(tokenizeBlock("{{query: {and: [[A]] {or: [[B]] [[C]]}}}}")).toEqual([
      { kind: "query", expr: "{and: [[A]] {or: [[B]] [[C]]}}" },
    ]);
    expect(tokenizeBlock("before {{[[query]]: {and: [[A]]}}} after")).toEqual([
      { kind: "text", text: "before " },
      { kind: "query", expr: "{and: [[A]]}" },
      { kind: "text", text: " after" },
    ]);
  });

  it("preserves newlines as line breaks outside code fences", () => {
    expect(tokenizeBlock("line one\nline two")).toEqual([
      { kind: "text", text: "line one" },
      { kind: "linebreak" },
      { kind: "text", text: "line two" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/grammar`
Expected: FAIL — cannot resolve `./refs` and `./tokenize`.

- [ ] **Step 3: Implement refs.ts**

`web/src/grammar/refs.ts`:
```typescript
// pattern: Functional Core
// Mirrors server/src/pkm/refs.py EXACTLY; pinned by
// shared/fixtures/ref_grammar.json (both parsers must pass it).

export type RefKind = "link" | "tag" | "attribute";

export interface Ref {
  title: string;
  kind: RefKind;
}

export interface ParsedRefs {
  refs: Ref[];
  block_refs: string[];
  embeds: number;
}

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const ATTRIBUTE = /^\s*([^\[\]{}:\n]+?)::/;
// [\p{L}\p{N}_] mirrors Python's unicode-aware \w closely enough for titles.
const HASHTAG = /(?<=^|[\s(])#([\p{L}\p{N}_./\-]+)/gu;
const BLOCK_REF = /\(\(([a-zA-Z0-9_-]{6,})\)\)/g;
const EMBED = /\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]/g;

function stripCode(text: string): string {
  const blank = (m: string) => " ".repeat(m.length); // keep offsets/line starts
  return text.replace(CODE_FENCE, blank).replace(INLINE_CODE, blank);
}

/** Balanced [[...]] scan. Nested links yield outer then inner titles.
 * Returns [title, isTag] pairs; isTag when written as #[[...]]. */
function scanBrackets(text: string, nested: boolean): [string, boolean][] {
  const out: [string, boolean][] = [];
  let i = 0;
  const n = text.length;
  while (i < n - 1) {
    if (text[i] === "[" && text[i + 1] === "[") {
      let depth = 1;
      let j = i + 2;
      while (j < n - 1 && depth > 0) {
        const pair = text.slice(j, j + 2);
        if (pair === "[[") { depth += 1; j += 2; }
        else if (pair === "]]") { depth -= 1; j += 2; }
        else { j += 1; }
      }
      if (depth === 0) {
        const inner = text.slice(i + 2, j - 2);
        const isTag = !nested && i > 0 && text[i - 1] === "#";
        out.push([inner, isTag]);
        out.push(...scanBrackets(inner, true));
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export function extractRefs(text: string): ParsedRefs {
  const clean = stripCode(text);
  const refs: Ref[] = [];
  const attr = ATTRIBUTE.exec(clean);
  if (attr) refs.push({ title: attr[1].trim(), kind: "attribute" });
  for (const [title, isTag] of scanBrackets(clean, false)) {
    refs.push({ title, kind: isTag ? "tag" : "link" });
  }
  for (const m of clean.matchAll(HASHTAG)) {
    refs.push({ title: m[1], kind: "tag" });
  }
  const seen = new Set<string>();
  const deduped = refs.filter((r) => {
    const key = `${r.kind}\x00${r.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    refs: deduped,
    block_refs: [...clean.matchAll(BLOCK_REF)].map((m) => m[1]),
    embeds: [...clean.matchAll(EMBED)].length,
  };
}
```

- [ ] **Step 4: Implement tokenize.ts**

`web/src/grammar/tokenize.ts`:
```typescript
// pattern: Functional Core
// Tokenizes Roam-flavoured block text into typed segments for rendering.
// Ref *extraction* lives in refs.ts; both follow server/src/pkm/refs.py
// semantics (code first, attribute at block start, tag charset, uid shape).

export type EmphasisKind = "bold" | "italic" | "strike" | "highlight";

export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "linebreak" }
  | { kind: "inline-code"; code: string }
  | { kind: "page-ref"; title: string; tag: boolean }
  | { kind: "attribute"; name: string }
  | { kind: "block-ref"; uid: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "link"; text: string; href: string }
  | { kind: EmphasisKind; children: InlineSegment[] };

export type BlockSegment =
  | InlineSegment
  | { kind: "todo"; done: boolean }
  | { kind: "code-block"; lang: string | null; code: string }
  | { kind: "query"; expr: string };

const TODO_PREFIX = /^\{\{(?:\[\[)?(TODO|DONE)(?:\]\])?\}\}\s?/;
const QUERY_PREFIX = /^\{\{(?:\[\[)?query(?:\]\])?:\s*/;
const ATTRIBUTE = /^\s*([^\[\]{}:\n]+?)::/;
const BLOCK_REF_AT = /^\(\(([a-zA-Z0-9_-]{6,})\)\)/;
const TAG_CHARS = /^[\p{L}\p{N}_./\-]+/u;

const EMPHASIS: [string, EmphasisKind][] = [
  ["**", "bold"], ["__", "italic"], ["~~", "strike"], ["^^", "highlight"],
];

/** From i pointing at "[[": index just past the closing "]]", or -1. */
function scanDoubleBrackets(text: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < text.length - 1 && depth > 0) {
    const pair = text.slice(j, j + 2);
    if (pair === "[[") { depth += 1; j += 2; }
    else if (pair === "]]") { depth -= 1; j += 2; }
    else { j += 1; }
  }
  return depth === 0 ? j : -1;
}

/** From i pointing at "{{[[query]]:" / "{{query:": [expr, end] via a
 * balanced-brace scan (the expr itself contains braces), or null. */
function scanQuery(text: string, i: number): [string, number] | null {
  const m = QUERY_PREFIX.exec(text.slice(i));
  if (!m) return null;
  let depth = 2; // the two braces of "{{"
  let j = i + 2;
  while (j < text.length && depth > 0) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}") depth -= 1;
    j += 1;
  }
  if (depth !== 0) return null;
  return [text.slice(i + m[0].length, j - 2).trim(), j];
}

/** From i pointing at "[": {text, href, end} for [text](href), or null. */
function scanMarkdownLink(
  text: string, i: number,
): { text: string; href: string; end: number } | null {
  let depth = 1;
  let j = i + 1;
  while (j < text.length && depth > 0) {
    if (text[j] === "\n") return null;
    if (text[j] === "[") depth += 1;
    else if (text[j] === "]") depth -= 1;
    j += 1;
  }
  if (depth !== 0 || text[j] !== "(") return null;
  const close = text.indexOf(")", j + 1);
  if (close === -1 || text.slice(j + 1, close).includes("\n")) return null;
  return { text: text.slice(i + 1, j - 1), href: text.slice(j + 1, close), end: close + 1 };
}

function parseFence(body: string): BlockSegment {
  const nl = body.indexOf("\n");
  if (nl === -1) return { kind: "code-block", lang: null, code: body };
  const lang = body.slice(0, nl).trim();
  return {
    kind: "code-block",
    lang: lang || null,
    code: body.slice(nl + 1).replace(/\n$/, ""),
  };
}

function tokenizeInline(text: string, blockStart: boolean): InlineSegment[] {
  const out: InlineSegment[] = [];
  let buf = "";
  const flushText = () => {
    if (buf) { out.push({ kind: "text", text: buf }); buf = ""; }
  };
  let i = 0;
  if (blockStart) {
    const m = ATTRIBUTE.exec(text);
    if (m) {
      out.push({ kind: "attribute", name: m[1].trim() });
      i = m[0].length;
    }
  }
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      flushText();
      out.push({ kind: "linebreak" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (close !== -1 && (nl === -1 || close < nl)) {
        flushText();
        out.push({ kind: "inline-code", code: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "!" && text.startsWith("![", i)) {
      const link = scanMarkdownLink(text, i + 1);
      if (link) {
        flushText();
        out.push({ kind: "image", alt: link.text, src: link.href });
        i = link.end;
        continue;
      }
    }
    if (ch === "[" && text.startsWith("[[", i)) {
      const end = scanDoubleBrackets(text, i);
      if (end !== -1) {
        flushText();
        out.push({ kind: "page-ref", title: text.slice(i + 2, end - 2), tag: false });
        i = end;
        continue;
      }
    }
    if (ch === "[" && !text.startsWith("[[", i)) {
      const link = scanMarkdownLink(text, i);
      if (link) {
        flushText();
        out.push({ kind: "link", text: link.text, href: link.href });
        i = link.end;
        continue;
      }
    }
    if (ch === "#") {
      if (text.startsWith("#[[", i)) {
        const end = scanDoubleBrackets(text, i + 1);
        if (end !== -1) {
          flushText();
          out.push({ kind: "page-ref", title: text.slice(i + 3, end - 2), tag: true });
          i = end;
          continue;
        }
      }
      const prev = i === 0 ? " " : text[i - 1];
      const m = TAG_CHARS.exec(text.slice(i + 1));
      if (m && /[\s(]/.test(prev)) {
        flushText();
        out.push({ kind: "page-ref", title: m[0], tag: true });
        i += 1 + m[0].length;
        continue;
      }
    }
    if (ch === "(" && text.startsWith("((", i)) {
      const m = BLOCK_REF_AT.exec(text.slice(i));
      if (m) {
        flushText();
        out.push({ kind: "block-ref", uid: m[1] });
        i += m[0].length;
        continue;
      }
    }
    let matchedEmphasis = false;
    for (const [marker, kind] of EMPHASIS) {
      if (!text.startsWith(marker, i)) continue;
      const close = text.indexOf(marker, i + 2);
      if (close === -1 || close === i + 2) continue;
      const inner = text.slice(i + 2, close);
      if (inner.includes("\n")) continue;
      flushText();
      out.push({ kind, children: tokenizeInline(inner, false) });
      i = close + 2;
      matchedEmphasis = true;
      break;
    }
    if (matchedEmphasis) continue;
    buf += ch;
    i += 1;
  }
  flushText();
  return out;
}

export function tokenizeBlock(text: string): BlockSegment[] {
  const out: BlockSegment[] = [];
  let rest = text;
  const todo = TODO_PREFIX.exec(rest);
  if (todo) {
    out.push({ kind: "todo", done: todo[1] === "DONE" });
    rest = rest.slice(todo[0].length);
  }
  const first = !todo; // attribute can only start an un-prefixed block
  let i = 0;
  let chunkStart = 0;
  const flush = (end: number) => {
    if (end > chunkStart) {
      out.push(...tokenizeInline(rest.slice(chunkStart, end), first && chunkStart === 0));
    }
  };
  while (i < rest.length) {
    if (rest.startsWith("```", i)) {
      const close = rest.indexOf("```", i + 3);
      if (close !== -1) {
        flush(i);
        out.push(parseFence(rest.slice(i + 3, close)));
        i = close + 3;
        chunkStart = i;
        continue;
      }
    }
    if (rest.startsWith("{{", i)) {
      const q = scanQuery(rest, i);
      if (q) {
        flush(i);
        out.push({ kind: "query", expr: q[0] });
        i = q[1];
        chunkStart = i;
        continue;
      }
    }
    i += 1;
  }
  flush(rest.length);
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all 11 fixture cases + all tokenizer tests PASS; tsc clean.

- [ ] **Step 6: Commit and push**

```bash
git add web/ && git commit -m "feat: TS grammar core pinned to the shared ref fixture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 4: Inline renderer — segments → React, plus code/asset/pdf/todo/block-ref components

**Files:**
- Create: `web/src/paths.ts`, `web/src/contexts.ts`, `web/src/components/PageLink.tsx`, `web/src/components/InlineSegments.tsx`, `web/src/components/CodeBlock.tsx`, `web/src/components/AssetImage.tsx`, `web/src/components/PdfEmbed.tsx`, `web/src/components/BlockRef.tsx`, `web/src/components/TodoCheckbox.tsx`
- Test: `web/src/components/InlineSegments.test.tsx`

**Interfaces:**
- Consumes: `tokenizeBlock`/`BlockSegment`/`InlineSegment` (Task 3), `BlockRefText` (Task 2), react-router `Link`.
- Produces (Tasks 5–11 consume; names are load-bearing):
  - `paths.ts`: `encodeTitle(title: string): string` (per-segment encodeURIComponent, `/` stays literal), `pagePath(title: string): string` (`/page/` + encodeTitle), `titleFromPathname(pathname: string): string` (per-segment decode)
  - `contexts.ts`: `SidebarApi { openInSidebar: (title: string) => void }`, `SidebarContext` (default no-op), `BlockRefContext: Context<Record<string, BlockRefText>>` (default `{}`)
  - `PageLink({ title, tag }: { title: string; tag: boolean })` — router Link to `pagePath(title)`; shift-click prevents navigation and calls `openInSidebar(title)`
  - `InlineSegments({ segments, depth }: { segments: BlockSegment[]; depth?: number })` — the single segment→React dispatcher (depth guards block-ref recursion, default 0)
  - `CodeBlock({ lang, code })`, `AssetImage({ src, alt })`, `PdfEmbed({ href, label })`, `BlockRef({ uid, depth })`, `TodoCheckbox({ done })`
  - `{kind:"query"}` segments render as an inert `.query-pending` span in this task — Task 10 swaps in the live `QueryBlock`.

- [ ] **Step 1: Write the failing tests**

`web/src/components/InlineSegments.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BlockRefText } from "../api/payloads";
import { BlockRefContext, SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

function renderText(text: string, refTexts: Record<string, BlockRefText> = {}) {
  return render(
    <MemoryRouter>
      <BlockRefContext.Provider value={refTexts}>
        <InlineSegments segments={tokenizeBlock(text)} />
      </BlockRefContext.Provider>
    </MemoryRouter>,
  );
}

it("renders page links with namespace-preserving hrefs", () => {
  renderText("see [[AWS/SCP]]");
  expect(screen.getByRole("link", { name: "AWS/SCP" }))
    .toHaveAttribute("href", "/page/AWS/SCP");
});

it("renders tags with a # prefix and tag class", () => {
  renderText("about #AI");
  const link = screen.getByRole("link", { name: "#AI" });
  expect(link).toHaveClass("tag");
  expect(link).toHaveAttribute("href", "/page/AI");
});

it("renders attributes as a link to the attribute page followed by ::", () => {
  renderText("Tags:: #AI");
  expect(screen.getByRole("link", { name: "Tags" }))
    .toHaveAttribute("href", "/page/Tags");
});

it("renders fenced code inside pre.code-block", () => {
  const { container } = renderText("```python\nx = 1\n```");
  const pre = container.querySelector("pre.code-block");
  expect(pre).not.toBeNull();
  expect(pre!.textContent).toContain("x = 1");
});

it("resolves block refs from context and falls back to the literal", () => {
  renderText("See ((abc123XYZ))",
    { abc123XYZ: { text: "resolved [[Paper]]", page_title: "Papers" } });
  expect(screen.getByText(/resolved/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
});

it("renders unresolved block refs as the literal uid", () => {
  renderText("See ((zzz999zzz))");
  expect(screen.getByText("((zzz999zzz))")).toBeInTheDocument();
});

it("renders read-only TODO/DONE checkboxes", () => {
  renderText("{{[[TODO]]}} buy milk");
  const box = screen.getByRole("checkbox");
  expect(box).not.toBeChecked();
  expect(box).toBeDisabled();
  expect(screen.getByText("buy milk")).toBeInTheDocument();
});

it("renders images, pdf embeds for /assets/*.pdf links, and external links", () => {
  const sha = "ab".repeat(32);
  const { container } = renderText(
    `![shot](/assets/${sha}/pic.png) [Notes](/assets/${sha}/doc.pdf) [ext](https://x.org)`);
  expect(container.querySelector(`img[src="/assets/${sha}/pic.png"]`)).not.toBeNull();
  expect(container.querySelector(`embed[src="/assets/${sha}/doc.pdf"]`)).not.toBeNull();
  expect(screen.getByRole("link", { name: "Notes" }))
    .toHaveAttribute("href", `/assets/${sha}/doc.pdf`);
  expect(screen.getByRole("link", { name: "ext" }))
    .toHaveAttribute("target", "_blank");
});

it("shift-click calls the sidebar callback instead of navigating", () => {
  const openInSidebar = vi.fn();
  render(
    <MemoryRouter>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <InlineSegments segments={tokenizeBlock("go [[Paper]]")} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(openInSidebar).toHaveBeenCalledWith("Paper");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/components`
Expected: FAIL — cannot resolve `../contexts` / `./InlineSegments`.

- [ ] **Step 3: Implement**

`web/src/paths.ts`:
```typescript
// pattern: Functional Core
// Titles may contain "/" (namespace pages): encode per segment so the slash
// stays literal for the server's path-typed {title:path} routes.

export function encodeTitle(title: string): string {
  return title.split("/").map(encodeURIComponent).join("/");
}

export function pagePath(title: string): string {
  return `/page/${encodeTitle(title)}`;
}

export function titleFromPathname(pathname: string): string {
  return pathname
    .replace(/^\/page\//, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
}
```

`web/src/contexts.ts`:
```typescript
// pattern: Functional Core
import { createContext } from "react";
import type { BlockRefText } from "./api/payloads";

export interface SidebarApi {
  openInSidebar: (title: string) => void;
}

export const SidebarContext = createContext<SidebarApi>({
  openInSidebar: () => undefined,
});

/** uid -> resolved text of ((uid)) block refs, from the page payload. */
export const BlockRefContext = createContext<Record<string, BlockRefText>>({});
```

`web/src/components/PageLink.tsx`:
```tsx
// pattern: Functional Core
import { useContext } from "react";
import { Link } from "react-router-dom";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";

export function PageLink({ title, tag }: { title: string; tag: boolean }) {
  const { openInSidebar } = useContext(SidebarContext);
  return (
    <Link
      to={pagePath(title)}
      className={tag ? "tag" : "page-link"}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          openInSidebar(title);
        }
      }}
    >
      {tag ? `#${title}` : title}
    </Link>
  );
}
```

`web/src/components/CodeBlock.tsx`:
```tsx
// pattern: Functional Core
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";

export function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  if (lang && hljs.getLanguage(lang)) {
    // Auto-detect stays off: only the fence's language tag selects a grammar.
    // hljs escapes its input; this HTML is library-generated, not server text
    // (the "no dangerouslySetInnerHTML" rule targets FTS snippets).
    const html = hljs.highlight(code, { language: lang }).value;
    return (
      <pre className="code-block">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    );
  }
  return (
    <pre className="code-block">
      <code>{code}</code>
    </pre>
  );
}
```

`web/src/components/AssetImage.tsx`:
```tsx
// pattern: Functional Core
export function AssetImage({ src, alt }: { src: string; alt: string }) {
  return <img className="asset-image" src={src} alt={alt} loading="lazy" />;
}
```

`web/src/components/PdfEmbed.tsx`:
```tsx
// pattern: Functional Core
export function PdfEmbed({ href, label }: { href: string; label: string }) {
  return (
    <span className="pdf-embed">
      <embed type="application/pdf" src={href} className="pdf-viewer" />
      <a href={href} download className="pdf-download">
        {label || "Download PDF"}
      </a>
    </span>
  );
}
```

`web/src/components/TodoCheckbox.tsx`:
```tsx
// pattern: Functional Core
export function TodoCheckbox({ done }: { done: boolean }) {
  return (
    <input type="checkbox" className="todo-checkbox"
           checked={done} readOnly disabled />
  );
}
```

`web/src/components/BlockRef.tsx`:
```tsx
// pattern: Functional Core
import { useContext } from "react";
import { BlockRefContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

// Mutually-referencing blocks in the same payload could otherwise recurse
// forever (A's text embeds B's, whose text embeds A's, ...).
const MAX_DEPTH = 3;

export function BlockRef({ uid, depth }: { uid: string; depth: number }) {
  const refTexts = useContext(BlockRefContext);
  const resolved = refTexts[uid];
  if (!resolved || depth >= MAX_DEPTH) {
    return <span className="block-ref unresolved">(({uid}))</span>;
  }
  return (
    <span className="block-ref" title={`from ${resolved.page_title}`}>
      <InlineSegments segments={tokenizeBlock(resolved.text)} depth={depth + 1} />
    </span>
  );
}
```

`web/src/components/InlineSegments.tsx` (the import cycle with BlockRef is render-time only — safe in ESM):
```tsx
// pattern: Functional Core
import type { BlockSegment } from "../grammar/tokenize";
import { AssetImage } from "./AssetImage";
import { BlockRef } from "./BlockRef";
import { CodeBlock } from "./CodeBlock";
import { PageLink } from "./PageLink";
import { PdfEmbed } from "./PdfEmbed";
import { TodoCheckbox } from "./TodoCheckbox";

function isPdfAssetHref(href: string): boolean {
  return href.startsWith("/assets/") && href.toLowerCase().endsWith(".pdf");
}

export function InlineSegments({ segments, depth = 0 }:
    { segments: BlockSegment[]; depth?: number }) {
  return (
    <>
      {segments.map((seg, i) => <Segment key={i} seg={seg} depth={depth} />)}
    </>
  );
}

function Segment({ seg, depth }: { seg: BlockSegment; depth: number }) {
  switch (seg.kind) {
    case "text":
      return <>{seg.text}</>;
    case "linebreak":
      return <br />;
    case "inline-code":
      return <code className="inline-code">{seg.code}</code>;
    case "page-ref":
      return <PageLink title={seg.title} tag={seg.tag} />;
    case "attribute":
      return (
        <span className="attribute">
          <PageLink title={seg.name} tag={false} />::
        </span>
      );
    case "block-ref":
      return <BlockRef uid={seg.uid} depth={depth} />;
    case "image":
      return <AssetImage src={seg.src} alt={seg.alt} />;
    case "link":
      return isPdfAssetHref(seg.href)
        ? <PdfEmbed href={seg.href} label={seg.text} />
        : <a href={seg.href} target="_blank" rel="noreferrer">{seg.text}</a>;
    case "bold":
      return <strong><InlineSegments segments={seg.children} depth={depth} /></strong>;
    case "italic":
      return <em><InlineSegments segments={seg.children} depth={depth} /></em>;
    case "strike":
      return <s><InlineSegments segments={seg.children} depth={depth} /></s>;
    case "highlight":
      return <mark className="highlight"><InlineSegments segments={seg.children} depth={depth} /></mark>;
    case "todo":
      return <TodoCheckbox done={seg.done} />;
    case "code-block":
      return <CodeBlock lang={seg.lang} code={seg.code} />;
    case "query":
      // Task 10 replaces this inert span with the live <QueryBlock>.
      return <span className="query-pending">{`{{query: ${seg.expr}}}`}</span>;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: inline segment renderer with code, asset, pdf, todo, block-ref components

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 5: Block outline — `Block` + `BlockTree` with headings and collapse toggle

**Files:**
- Create: `web/src/components/BlockTree.tsx`
- Test: `web/src/components/BlockTree.test.tsx`

**Interfaces:**
- Consumes: `BlockNode` (Task 2), `tokenizeBlock` (Task 3), `InlineSegments` (Task 4).
- Produces (Tasks 6, 8, 11 consume):
  - `BlockTree({ blocks }: { blocks: BlockNode[] })` — bullet outline
  - `Block({ node }: { node: BlockNode })` — one bullet row: chevron (hidden when childless), bullet, text (heading 1–3 → h1/h2/h3 styling, else div); children indented; `node.collapsed` is the INITIAL state, toggling is client-side only (persisting collapse is a plan-5 op)

- [ ] **Step 1: Write the failing tests**

`web/src/components/BlockTree.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { BlockTree } from "./BlockTree";

function block(uid: string, text: string, over: Partial<BlockNode> = {}): BlockNode {
  return { uid, text, heading: null, collapsed: false,
           created_at: 1000, updated_at: 2000, children: [], ...over };
}

function renderTree(blocks: BlockNode[]) {
  return render(<MemoryRouter><BlockTree blocks={blocks} /></MemoryRouter>);
}

it("renders nested blocks with heading levels", () => {
  renderTree([
    block("uid_a1", "Papers", { heading: 2, children: [
      block("uid_a2", "read [[Paper]]"),
    ] }),
  ]);
  const heading = screen.getByText("Papers");
  expect(heading.closest("h2")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
});

it("respects the collapsed initial state and toggles on chevron click", () => {
  renderTree([
    block("uid_a1", "parent", { collapsed: true, children: [
      block("uid_a2", "hidden child"),
    ] }),
  ]);
  expect(screen.queryByText("hidden child")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "toggle children" })[0]);
  expect(screen.getByText("hidden child")).toBeInTheDocument();
});

it("hides the chevron on childless blocks", () => {
  const { container } = renderTree([block("uid_a1", "leaf")]);
  expect(container.querySelector(".chevron.hidden")).not.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/components/BlockTree.test.tsx`
Expected: FAIL — cannot resolve `./BlockTree`.

- [ ] **Step 3: Implement**

`web/src/components/BlockTree.tsx`:
```tsx
// pattern: Functional Core
import { useState } from "react";
import type { BlockNode } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

export function Block({ node }: { node: BlockNode }) {
  // node.collapsed seeds the state; toggling is view-only in plan 4
  // (persisting collapse is a plan-5 set_collapsed op).
  const [collapsed, setCollapsed] = useState(node.collapsed);
  const hasChildren = node.children.length > 0;
  const Tag: "h1" | "h2" | "h3" | "div" =
    node.heading === 1 ? "h1" :
    node.heading === 2 ? "h2" :
    node.heading === 3 ? "h3" : "div";
  return (
    <div className="block">
      <div className="block-row">
        <button
          className={"chevron" + (collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => setCollapsed(!collapsed)}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className="bullet">•</span>
        <Tag className="block-text">
          <InlineSegments segments={tokenizeBlock(node.text)} />
        </Tag>
      </div>
      {hasChildren && !collapsed && (
        <div className="block-children">
          {node.children.map((c) => <Block key={c.uid} node={c} />)}
        </div>
      )}
    </div>
  );
}

export function BlockTree({ blocks }: { blocks: BlockNode[] }) {
  return (
    <div className="block-tree">
      {blocks.map((b) => <Block key={b.uid} node={b} />)}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: block outline tree with headings and collapse toggle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 6: App shell, routing, PageView basics + core CSS

Routes: `/` (Journal home — placeholder element until Task 8) and `/page/*` (splat, because titles contain `/`). Left nav carries "Daily Notes" only in v1 — the Roam `:page/sidebar` shortcuts were not imported (spec findings), so nav shortcuts are explicitly out of scope. Search button arrives with the modal in Task 9.

**Files:**
- Create: `web/src/views/PageView.tsx`, `web/src/test-helpers.ts`
- Modify: `web/src/App.tsx` (replace placeholder), `web/src/styles.css` (append layout/outline/inline sections)
- Test: `web/src/views/PageView.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (T2), `PagePayload` (T2), `titleFromPathname`/`encodeTitle` (T4), `BlockRefContext` (T4), `BlockTree` (T5).
- Produces:
  - `App()` — flex shell: `.left-nav` + `.main-pane` with `<Routes>`
  - `PageView()` — reads the title from `location.pathname` (splat param would eat encoded slashes; pathname decoding is per segment), fetches `/api/page/<encoded title>`, provides `block_ref_texts` via `BlockRefContext`, renders `.page-title` + `BlockTree`; loading/error states; sets `document.title`
  - `test-helpers.ts` (test-only, no FCIS header): `jsonResponse(body, status?)`, `stubFetch(handlers: [string, unknown][])` (first prefix match wins — order longest-prefix first), `block(uid, text, over?)`, `pagePayload(title, blocks, over?)` — fixture payloads shaped EXACTLY like routes_pages.py responses

- [ ] **Step 1: Write the test helpers and failing tests**

`web/src/test-helpers.ts` (test-only module; imported only from `*.test.tsx`):
```typescript
import { vi } from "vitest";
import type { BlockNode, PagePayload } from "./api/payloads";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global fetch; handlers are [urlPrefix, body] pairs, FIRST match
 * wins — list more-specific prefixes first. Unmatched urls 404. */
export function stubFetch(handlers: [string, unknown][]) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, body] of handlers) {
      if (url.startsWith(prefix)) return jsonResponse(body);
    }
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function block(uid: string, text: string,
                      over: Partial<BlockNode> = {}): BlockNode {
  return { uid, text, heading: null, collapsed: false,
           created_at: 1000, updated_at: 2000, children: [], ...over };
}

export function pagePayload(title: string, blocks: BlockNode[],
                            over: Partial<PagePayload> = {}): PagePayload {
  return {
    page: { id: 1, title, created_at: 1000, updated_at: 2000 },
    blocks,
    backlinks: { groups: [], total_pages: 0, offset: 0, limit: 20 },
    block_ref_texts: {},
    ...over,
  };
}
```

`web/src/views/PageView.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { block, pagePayload, stubFetch } from "../test-helpers";
import { PageView } from "./PageView";

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/page/*" element={<PageView />} />
      </Routes>
    </MemoryRouter>,
  );
}

it("fetches and renders a page, resolving block refs from the payload", async () => {
  const fetchMock = stubFetch([
    ["/api/page/Generative%20Models", pagePayload("Generative Models", [
      block("uid_p1", "intro [[Paper]]"),
      block("uid_p2", "See ((uid_r1))"),
    ], { block_ref_texts: { uid_r1: { text: "the referenced text", page_title: "Paper" } } })],
  ]);
  renderAt("/page/Generative%20Models");
  expect(await screen.findByRole("heading", { name: "Generative Models" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.getByText("the referenced text")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Generative%20Models", undefined);
});

it("keeps literal slashes in namespace titles", async () => {
  const fetchMock = stubFetch([
    ["/api/page/AWS/SCP", pagePayload("AWS/SCP", [block("uid_n1", "scp notes")])],
  ]);
  renderAt("/page/AWS/SCP");
  expect(await screen.findByRole("heading", { name: "AWS/SCP" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/page/AWS/SCP", undefined);
});

it("shows an error state on 404", async () => {
  stubFetch([]);
  renderAt("/page/Nope");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/views`
Expected: FAIL — cannot resolve `./PageView`.

- [ ] **Step 3: Implement**

`web/src/views/PageView.tsx`:
```tsx
// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockTree } from "../components/BlockTree";
import { BlockRefContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";

export function PageView() {
  const { pathname } = useLocation();
  const title = titleFromPathname(pathname);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title]);

  useEffect(() => {
    document.title = `${title} — pkm`;
  }, [title]);

  if (error) return <p className="error">Could not load "{title}": {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefContext.Provider value={payload.block_ref_texts}>
      <article className="page">
        <h1 className="page-title">{payload.page.title}</h1>
        <BlockTree blocks={payload.blocks} />
      </article>
    </BlockRefContext.Provider>
  );
}
```

`web/src/App.tsx` (full replacement):
```tsx
// pattern: Imperative Shell
import { Link, Route, Routes } from "react-router-dom";
import { PageView } from "./views/PageView";

export function App() {
  return (
    <div className="app">
      <nav className="left-nav">
        <div className="nav-title">pkm</div>
        <Link to="/" className="nav-link">Daily Notes</Link>
      </nav>
      <main className="main-pane">
        <Routes>
          {/* Task 8 replaces this element with <Journal /> */}
          <Route path="/" element={<p className="empty">pkm</p>} />
          <Route path="/page/*" element={<PageView />} />
        </Routes>
      </main>
    </div>
  );
}
```

Append to `web/src/styles.css`:
```css
/* layout */
.app { display: flex; min-height: 100vh; }
.left-nav { width: 200px; flex-shrink: 0; padding: 16px; background: #f5f8fa;
  border-right: 1px solid #e1e8ed; display: flex; flex-direction: column; gap: 8px; }
.nav-title { font-weight: 700; margin-bottom: 8px; }
.nav-link { background: none; border: none; padding: 4px 0; text-align: left;
  color: #106ba3; cursor: pointer; }
.main-pane { flex: 1; min-width: 0; max-width: 800px; margin: 0 auto;
  padding: 24px 32px 120px; }
.page-title { font-size: 26px; margin: 0 0 12px; }
.page-title a { color: inherit; }
.loading, .empty, .empty-day { color: #8a9ba8; }
.error { color: #c23030; }

/* outline */
.block-row { display: flex; align-items: baseline; padding: 1px 0; border-radius: 3px; }
.block-row:hover { background: #f5f8fa; }
.chevron { background: none; border: none; cursor: pointer; color: #8a9ba8;
  width: 16px; padding: 0; flex-shrink: 0; transform: rotate(90deg);
  transition: transform 0.1s; }
.chevron.closed { transform: rotate(0deg); }
.chevron.hidden { visibility: hidden; }
.bullet { color: #8a9ba8; margin-right: 8px; flex-shrink: 0; font-size: 11px; }
.block-children { margin-left: 22px; border-left: 1px solid #eef2f5; padding-left: 8px; }
.block-text { margin: 0; font-weight: normal; min-width: 0; overflow-wrap: break-word; }
h1.block-text { font-size: 22px; font-weight: 600; }
h2.block-text { font-size: 19px; font-weight: 600; }
h3.block-text { font-size: 16px; font-weight: 600; }

/* inline */
.tag { color: #a7b6c2; }
.tag:hover { color: #106ba3; }
.attribute a { font-weight: 600; color: #202b33; }
.inline-code { background: #f5f8fa; border: 1px solid #e1e8ed; border-radius: 3px;
  padding: 0 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px; }
.code-block { background: #f5f8fa; border: 1px solid #e1e8ed; border-radius: 4px;
  padding: 10px 12px; overflow-x: auto; font-size: 13px; }
.code-block code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.block-ref { border-bottom: 1px dashed #b3c2ce; }
.block-ref.unresolved { color: #8a9ba8; }
mark.highlight { background: #fff3b8; }
.asset-image { max-width: 100%; border-radius: 4px; display: block; margin: 4px 0; }
.pdf-embed { display: block; margin: 4px 0; }
.pdf-viewer { width: 100%; height: 480px; border: 1px solid #e1e8ed; border-radius: 4px; }
.pdf-download { display: inline-block; margin-top: 4px; font-size: 13px; }
.todo-checkbox { margin-right: 6px; vertical-align: middle; }
.query-pending { color: #8a9ba8; font-style: italic; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: app shell, routing, page view with core styles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 7: Backlinks (with breadcrumbs + show-more) and unlinked references (lazy, collapsed)

Backlinks render below the page body from the SAME payload (no extra fetch on load); "show more" re-hits `/api/page/<title>?bl_offset=N` and appends the next batch of source-page groups (bl pagination counts source PAGES — `total_pages`). Unlinked references are collapsed by default; opening the section triggers `GET /api/unlinked?title=…` (paginated by BLOCKS — `total`).

**Files:**
- Create: `web/src/components/groups.ts`, `web/src/components/BacklinksSection.tsx`, `web/src/components/UnlinkedSection.tsx`
- Modify: `web/src/views/PageView.tsx` (render both sections), `web/src/styles.css` (append)
- Test: `web/src/components/sections.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `Backlinks`/`BacklinkGroup`/`BlockGroup`/`GroupsPayload`/`PagePayload`/`BlockRefText` (T2), `BlockRefContext` (T4), `InlineSegments`/`PageLink` (T4), `tokenizeBlock` (T3).
- Produces:
  - `mergeGroups(existing: BlockGroup[], incoming: BlockGroup[]): BlockGroup[]` — pure; merges pagination batches by `page_id`, dedupes items by `uid` (also used by Task 10's QueryBlock)
  - `BacklinksSection({ title, initial }: { title: string; initial: Backlinks })` — groups with source-page title header, items with faint breadcrumb trail, show-more appends next `bl_offset` page and merges its `block_ref_texts` into a local `BlockRefContext` provider
  - `UnlinkedSection({ title }: { title: string })` — collapsed header; first open fetches; show-more paginates by accumulated item count
  - PageView mounts both keyed by title (`key={title}`) so navigation resets their state

- [ ] **Step 1: Write the failing tests**

`web/src/components/sections.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Backlinks } from "../api/payloads";
import { pagePayload, stubFetch } from "../test-helpers";
import { BacklinksSection } from "./BacklinksSection";
import { mergeGroups } from "./groups";
import { UnlinkedSection } from "./UnlinkedSection";

afterEach(() => vi.unstubAllGlobals());

const initial: Backlinks = {
  groups: [{
    page_id: 3,
    page_title: "July 7th, 2026",
    items: [{ uid: "uid_b4", text: "Studying [[Machine Learning]] today",
              breadcrumbs: ["Morning", "Reading"] }],
  }],
  total_pages: 2,
  offset: 0,
  limit: 20,
};

it("mergeGroups merges batches by page_id and dedupes items", () => {
  const merged = mergeGroups(
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }] }],
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }, { uid: "u2", text: "two" }] },
     { page_id: 2, page_title: "B", items: [{ uid: "u3", text: "three" }] }],
  );
  expect(merged).toEqual([
    { page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one" }, { uid: "u2", text: "two" }] },
    { page_id: 2, page_title: "B", items: [{ uid: "u3", text: "three" }] },
  ]);
});

it("renders backlink groups with breadcrumbs and loads more on demand", async () => {
  const more = pagePayload("Machine Learning", [], {
    backlinks: {
      groups: [{ page_id: 9, page_title: "AI", items: [
        { uid: "uid_b9", text: "more [[Machine Learning]]", breadcrumbs: [] }] }],
      total_pages: 2, offset: 1, limit: 20,
    },
  });
  const fetchMock = stubFetch([["/api/page/Machine%20Learning?bl_offset=1", more]]);
  render(
    <MemoryRouter>
      <BacklinksSection title="Machine Learning" initial={initial} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/linked references \(2\)/i)).toBeInTheDocument();
  expect(screen.getByText("Morning › Reading")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "July 7th, 2026" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByRole("link", { name: "AI" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/page/Machine%20Learning?bl_offset=1&bl_limit=20", undefined);
  // 2 groups loaded of total_pages 2 -> button gone
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("unlinked references fetch lazily on first open and paginate", async () => {
  const fetchMock = stubFetch([
    ["/api/unlinked?title=Machine%20Learning&limit=20&offset=1", {
      groups: [{ page_id: 5, page_title: "AGI", items: [
        { uid: "uid_u2", text: "machine learning épilogue" }] }],
      total: 2,
    }],
    ["/api/unlinked?title=Machine%20Learning", {
      groups: [{ page_id: 2, page_title: "AI", items: [
        { uid: "uid_u1", text: "AI overview mentions Machine Learning in plain text" }] }],
      total: 2,
    }],
  ]);
  render(
    <MemoryRouter>
      <UnlinkedSection title="Machine Learning" />
    </MemoryRouter>,
  );
  expect(fetchMock).not.toHaveBeenCalled(); // collapsed = no fetch
  fireEvent.click(screen.getByText(/unlinked references/i));
  expect(await screen.findByText(/mentions Machine Learning/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByText(/épilogue/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/components/sections.test.tsx`
Expected: FAIL — cannot resolve `./groups`, `./BacklinksSection`, `./UnlinkedSection`.

- [ ] **Step 3: Implement**

`web/src/components/groups.ts`:
```typescript
// pattern: Functional Core
import type { BlockGroup } from "../api/payloads";

/** Merge a later pagination batch into accumulated groups: same page_id
 * extends the existing group (deduped by uid), new pages append. */
export function mergeGroups(existing: BlockGroup[],
                            incoming: BlockGroup[]): BlockGroup[] {
  const out = existing.map((g) => ({ ...g, items: [...g.items] }));
  const index = new Map(out.map((g) => [g.page_id, g]));
  for (const g of incoming) {
    const found = index.get(g.page_id);
    if (found) {
      const seen = new Set(found.items.map((i) => i.uid));
      found.items.push(...g.items.filter((i) => !seen.has(i.uid)));
    } else {
      const copy = { ...g, items: [...g.items] };
      index.set(g.page_id, copy);
      out.push(copy);
    }
  }
  return out;
}
```

`web/src/components/BacklinksSection.tsx`:
```tsx
// pattern: Imperative Shell
import { useContext, useState } from "react";
import { apiFetch } from "../api/client";
import type { BacklinkGroup, Backlinks, BlockRefText, PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { encodeTitle } from "../paths";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";

export function BacklinksSection({ title, initial }:
    { title: string; initial: Backlinks }) {
  const base = useContext(BlockRefContext);
  const [groups, setGroups] = useState<BacklinkGroup[]>(initial.groups);
  const [extraRefTexts, setExtraRefTexts] =
    useState<Record<string, BlockRefText>>({});
  const [loading, setLoading] = useState(false);
  const hasMore = groups.length < initial.total_pages;

  const loadMore = async () => {
    setLoading(true);
    try {
      // bl pagination counts source pages; groups.length is the next offset.
      const p = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(title)}?bl_offset=${groups.length}&bl_limit=${initial.limit}`);
      setGroups((g) => [...g, ...p.backlinks.groups]);
      setExtraRefTexts((m) => ({ ...m, ...p.block_ref_texts }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <BlockRefContext.Provider value={{ ...base, ...extraRefTexts }}>
      <section className="backlinks">
        <h2 className="section-header">Linked references ({initial.total_pages})</h2>
        {groups.map((g) => (
          <div className="backlink-group" key={g.page_id}>
            <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
            {g.items.map((item) => (
              <div className="backlink-item" key={item.uid}>
                {item.breadcrumbs.length > 0 && (
                  <div className="breadcrumbs">{item.breadcrumbs.join(" › ")}</div>
                )}
                <div className="backlink-text">
                  <InlineSegments segments={tokenizeBlock(item.text)} />
                </div>
              </div>
            ))}
          </div>
        ))}
        {hasMore && (
          <button className="show-more" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </BlockRefContext.Provider>
  );
}
```

`web/src/components/UnlinkedSection.tsx`:
```tsx
// pattern: Imperative Shell
import { useState } from "react";
import { apiFetch } from "../api/client";
import type { BlockGroup, GroupsPayload } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";
import { mergeGroups } from "./groups";

const PAGE_SIZE = 20;

export function UnlinkedSection({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<BlockGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = async (from: number) => {
    setLoading(true);
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/unlinked?title=${encodeURIComponent(title)}&limit=${PAGE_SIZE}&offset=${from}`);
      setGroups((g) => mergeGroups(g, p.groups));
      setTotal(p.total);
      // /api/unlinked paginates by blocks: advance by items received.
      setOffset(from + p.groups.reduce((n, gr) => n + gr.items.length, 0));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && total === null) void load(0); // lazy: fetch on first open only
  };

  return (
    <section className="unlinked">
      <h2 className="section-header collapsible" onClick={toggle}>
        <span className={"chevron" + (open ? "" : " closed")}>▸</span>
        {" "}Unlinked references{total !== null ? ` (${total})` : ""}
      </h2>
      {open && (
        <>
          {groups.map((g) => (
            <div className="backlink-group" key={g.page_id}>
              <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
              {g.items.map((item) => (
                <div className="backlink-item" key={item.uid}>
                  <div className="backlink-text">
                    <InlineSegments segments={tokenizeBlock(item.text)} />
                  </div>
                </div>
              ))}
            </div>
          ))}
          {total !== null && offset < total && (
            <button className="show-more" onClick={() => void load(offset)} disabled={loading}>
              {loading ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
```

In `web/src/views/PageView.tsx`: add imports
```tsx
import { BacklinksSection } from "../components/BacklinksSection";
import { UnlinkedSection } from "../components/UnlinkedSection";
```
and replace the success return with:
```tsx
  return (
    <BlockRefContext.Provider value={payload.block_ref_texts}>
      <article className="page">
        <h1 className="page-title">{payload.page.title}</h1>
        <BlockTree blocks={payload.blocks} />
      </article>
      <BacklinksSection key={`bl-${title}`} title={title} initial={payload.backlinks} />
      <UnlinkedSection key={`ul-${title}`} title={title} />
    </BlockRefContext.Provider>
  );
```

Append to `web/src/styles.css`:
```css
/* backlinks + unlinked */
.backlinks, .unlinked { margin-top: 36px; border-top: 1px solid #e1e8ed; padding-top: 12px; }
.section-header { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;
  color: #5c7080; margin: 0 0 8px; }
.section-header.collapsible { cursor: pointer; user-select: none; }
.section-header .chevron { display: inline-block; transform: rotate(90deg); }
.section-header .chevron.closed { transform: rotate(0deg); }
.group-title { font-size: 15px; margin: 12px 0 4px; }
.backlink-item, .query-item { padding: 4px 0 4px 12px; border-left: 2px solid #eef2f5;
  margin: 4px 0; }
.breadcrumbs { font-size: 12px; color: #a7b6c2; margin-bottom: 2px; }
.show-more { margin-top: 8px; background: #f5f8fa; border: 1px solid #d8e1e8;
  border-radius: 3px; padding: 4px 12px; cursor: pointer; color: #5c7080; }
.show-more:hover { background: #ebf1f5; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS (including the Task 6 PageView tests — the empty `backlinks.groups` in the fixture renders an empty section); tsc clean.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: backlinks with breadcrumbs and lazy unlinked references

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 8: Daily-notes journal home with infinite scroll back

`GET /api/journal?days=5` returns days NEWEST-FIRST; its `before` parameter is EXCLUSIVE of the date given (server computes `start - 1 … start - days`), so the next batch passes the oldest date already received as `before` — no off-by-one arithmetic client-side. Auto-loading stops after 3 consecutive all-empty batches (the graph's history is finite; endless empty scroll is useless) and degrades to a manual "Load older days" button.

**Files:**
- Create: `web/src/views/Journal.tsx`
- Modify: `web/src/App.tsx` (route `/` → `<Journal />`), `web/src/styles.css` (append)
- Test: `web/src/views/Journal.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `JournalDay`/`JournalPayload` (T2), `pagePath` (T4), `BlockTree` (T5).
- Produces: `Journal()` — day sections (title links to `/page/<title>`), `IntersectionObserver` sentinel for scroll-back, `exists: false` days render "No notes". Journal payloads carry no `block_ref_texts`, so `((uid))`s in journal blocks render as literals (default context) — acceptable for v1, resolved on the page view.

- [ ] **Step 1: Write the failing tests**

`web/src/views/Journal.test.tsx`:
```tsx
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JournalDay } from "../api/payloads";
import { block, stubFetch } from "../test-helpers";
import { Journal } from "./Journal";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});
afterEach(() => vi.unstubAllGlobals());

function day(date: string, title: string, blocks = [block(`uid_${date}`, `entry ${date}`)],
             exists = true): JournalDay {
  return { date, title, exists, blocks: exists ? blocks : [] };
}

function intersect() {
  const entries = [{ isIntersecting: true }] as unknown as IntersectionObserverEntry[];
  act(() => {
    for (const o of FakeIntersectionObserver.instances) {
      o.callback(entries, o as unknown as IntersectionObserver);
    }
  });
}

it("renders the first batch newest-first and loads older days on intersect", async () => {
  const fetchMock = stubFetch([
    // more-specific prefix FIRST (plain ?days=5 also prefixes the before-url)
    ["/api/journal?days=5&before=2026-07-04", { days: [
      day("2026-07-03", "July 3rd, 2026"),
      day("2026-07-02", "July 2nd, 2026", [], false),
    ] }],
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026"),
      day("2026-07-07", "July 7th, 2026", [], false),
      day("2026-07-06", "July 6th, 2026"),
      day("2026-07-05", "July 5th, 2026", [], false),
      day("2026-07-04", "July 4th, 2026"),
    ] }],
  ]);
  render(<MemoryRouter><Journal /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "July 8th, 2026" }))
    .toHaveAttribute("href", "/page/July%208th%2C%202026");
  expect(screen.getByText("entry 2026-07-06")).toBeInTheDocument();
  expect(screen.getAllByText("No notes").length).toBe(2);

  intersect();
  expect(await screen.findByRole("link", { name: "July 3rd, 2026" })).toBeInTheDocument();
  // oldest already-loaded date is passed as the exclusive `before`
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/journal?days=5&before=2026-07-04", undefined);
});

it("stops auto-loading after 3 consecutive empty batches", async () => {
  const empty = (from: string, dates: string[]) =>
    [`/api/journal?days=5&before=${from}`,
     { days: dates.map((d) => day(d, d, [], false)) }] as [string, unknown];
  stubFetch([
    empty("2026-07-04", ["2026-07-03", "2026-07-02", "2026-07-01", "2026-06-30", "2026-06-29"]),
    empty("2026-06-29", ["2026-06-28", "2026-06-27", "2026-06-26", "2026-06-25", "2026-06-24"]),
    empty("2026-06-24", ["2026-06-23", "2026-06-22", "2026-06-21", "2026-06-20", "2026-06-19"]),
    ["/api/journal?days=5", { days: [
      day("2026-07-08", "July 8th, 2026"),
      day("2026-07-07", "July 7th, 2026", [], false),
      day("2026-07-06", "July 6th, 2026", [], false),
      day("2026-07-05", "July 5th, 2026", [], false),
      day("2026-07-04", "July 4th, 2026", [], false),
    ] }],
  ]);
  render(<MemoryRouter><Journal /></MemoryRouter>);
  await screen.findByRole("link", { name: "July 8th, 2026" });
  intersect();
  await screen.findByText("2026-07-03");
  intersect();
  await screen.findByText("2026-06-28");
  intersect();
  await screen.findByText("2026-06-23");
  // three all-empty batches in a row -> sentinel replaced by a manual button
  expect(await screen.findByRole("button", { name: /load older days/i }))
    .toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/views/Journal.test.tsx`
Expected: FAIL — cannot resolve `./Journal`.

- [ ] **Step 3: Implement**

`web/src/views/Journal.tsx`:
```tsx
// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { JournalDay, JournalPayload } from "../api/payloads";
import { BlockTree } from "../components/BlockTree";
import { pagePath } from "../paths";

const BATCH = 5;
const MAX_EMPTY_BATCHES = 3;

export function Journal() {
  const [days, setDays] = useState<JournalDay[]>([]);
  const [autoLoad, setAutoLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Refs, not state, so the IntersectionObserver callback never goes stale.
  const daysRef = useRef<JournalDay[]>([]);
  const emptyStreakRef = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const current = daysRef.current;
      const oldest = current[current.length - 1]?.date;
      // `before` is exclusive of the date given: passing the oldest loaded
      // date returns the day before it first (days come back newest-first).
      const qs = oldest ? `?days=${BATCH}&before=${oldest}` : `?days=${BATCH}`;
      const p = await apiFetch<JournalPayload>(`/api/journal${qs}`);
      const next = [...current, ...p.days];
      daysRef.current = next;
      setDays(next);
      emptyStreakRef.current =
        p.days.some((d) => d.exists) ? 0 : emptyStreakRef.current + 1;
      if (emptyStreakRef.current >= MAX_EMPTY_BATCHES) setAutoLoad(false);
    } catch (e: unknown) {
      setError(String(e));
      setAutoLoad(false);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => { void loadMore(); }, [loadMore]);
  useEffect(() => { document.title = "Daily Notes — pkm"; }, []);

  useEffect(() => {
    if (!autoLoad) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoLoad, loadMore]);

  return (
    <div className="journal">
      {days.map((day) => (
        <section className="journal-day" key={day.date}>
          <h1 className="page-title">
            <Link to={pagePath(day.title)}>{day.title}</Link>
          </h1>
          {day.exists && day.blocks.length > 0
            ? <BlockTree blocks={day.blocks} />
            : <p className="empty-day">No notes</p>}
        </section>
      ))}
      {error && <p className="error">{error}</p>}
      {autoLoad
        ? <div ref={sentinelRef} className="journal-sentinel" />
        : (
          <button className="show-more"
                  onClick={() => { setAutoLoad(true); void loadMore(); }}>
            Load older days
          </button>
        )}
    </div>
  );
}
```

In `web/src/App.tsx`: add `import { Journal } from "./views/Journal";` and replace the `/` route:
```tsx
          <Route path="/" element={<Journal />} />
```

Append to `web/src/styles.css`:
```css
/* journal */
.journal-day { margin-bottom: 40px; padding-bottom: 16px; border-bottom: 1px solid #eef2f5; }
.journal-sentinel { height: 1px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS; tsc clean. (Note: React StrictMode double-invokes the mount effect in dev; `loadingRef` makes the overlap harmless — at worst the first screen shows two batches.)

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: daily-notes journal home with infinite scroll back

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 9: Cmd-K search modal

Debounced (150ms) `GET /api/search?q=…`; page-title hits listed first, then block snippets. FTS5 snippets contain literal `<mark>…</mark>`: parse by splitting on the tags and render real `<mark>` elements — NEVER `dangerouslySetInnerHTML`.

**Files:**
- Create: `web/src/grammar/snippet.ts`, `web/src/components/SearchModal.tsx`
- Modify: `web/src/App.tsx` (Cmd-K listener, Search nav button, mount modal), `web/src/styles.css` (append)
- Test: `web/src/grammar/snippet.test.ts`, `web/src/components/SearchModal.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `SearchPayload` (T2), `pagePath` (T4), `useNavigate`.
- Produces:
  - `parseSnippet(snippet: string): { text: string; mark: boolean }[]` — pure split on literal `<mark>`/`</mark>`
  - `SearchModal({ open, onClose }: { open: boolean; onClose: () => void })` — input autofocus, ArrowUp/Down + Enter keyboard selection, click/Enter navigates to the hit's page and closes; Escape closes; overlay click closes
  - App: global `keydown` for Cmd-K / Ctrl-K toggling the modal; a "Search" button in the left nav

- [ ] **Step 1: Write the failing tests**

`web/src/grammar/snippet.test.ts`:
```typescript
import { expect, it } from "vitest";
import { parseSnippet } from "./snippet";

it("splits FTS snippets into marked and unmarked runs", () => {
  expect(parseSnippet("…uses <mark>datascript</mark> under the hood…")).toEqual([
    { text: "…uses ", mark: false },
    { text: "datascript", mark: true },
    { text: " under the hood…", mark: false },
  ]);
});

it("handles multiple marks and mark-first snippets", () => {
  expect(parseSnippet("<mark>a</mark> b <mark>c</mark>")).toEqual([
    { text: "a", mark: true },
    { text: " b ", mark: false },
    { text: "c", mark: true },
  ]);
});

it("never interprets other tags — text stays literal", () => {
  expect(parseSnippet("x <b>bold</b> y")).toEqual([
    { text: "x <b>bold</b> y", mark: false },
  ]);
});

it("tolerates an unclosed mark", () => {
  expect(parseSnippet("a <mark>b")).toEqual([
    { text: "a ", mark: false },
    { text: "b", mark: false },
  ]);
});
```

`web/src/components/SearchModal.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { SearchModal } from "./SearchModal";

afterEach(() => vi.unstubAllGlobals());

const results = {
  pages: [{ id: 4, title: "Paper" }],
  blocks: [{ uid: "uid_b3", page_title: "Machine Learning",
             snippet: "a <mark>paper</mark> about attention" }],
};

function renderModal(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <SearchModal open={true} onClose={onClose} />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

it("debounces input, lists pages before block snippets with real <mark>s", async () => {
  const fetchMock = stubFetch([["/api/search?q=paper", results]]);
  renderModal();
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "pap" } });
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "pape" } });
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "paper" } });
  const items = await screen.findAllByRole("listitem");
  expect(fetchMock).toHaveBeenCalledTimes(1); // only the settled query fired
  expect(items[0].textContent).toContain("Paper");           // page hit first
  expect(items[1].textContent).toContain("Machine Learning"); // then block hit
  const mark = items[1].querySelector("mark");
  expect(mark).not.toBeNull();
  expect(mark!.textContent).toBe("paper");
});

it("Enter navigates to the selected hit and closes", async () => {
  stubFetch([["/api/search?q=paper", results]]);
  const onClose = renderModal();
  const input = screen.getByPlaceholderText("Search…");
  fireEvent.change(input, { target: { value: "paper" } });
  await screen.findAllByRole("listitem");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByText("page view here")).toBeInTheDocument();
});

it("Escape closes without navigating", () => {
  stubFetch([]);
  const onClose = renderModal();
  fireEvent.keyDown(screen.getByPlaceholderText("Search…"), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/grammar/snippet.test.ts src/components/SearchModal.test.tsx`
Expected: FAIL — cannot resolve `./snippet` / `./SearchModal`.

- [ ] **Step 3: Implement**

`web/src/grammar/snippet.ts`:
```typescript
// pattern: Functional Core
// FTS5 snippets arrive with literal <mark>…</mark> markers. Split on the
// exact tags and return runs; the renderer emits real <mark> elements.
// Server text is NEVER injected as HTML.

const OPEN = "<mark>";
const CLOSE = "</mark>";

export function parseSnippet(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  const parts = snippet.split(OPEN);
  const head = parts[0];
  if (head) out.push({ text: head, mark: false });
  for (const part of parts.slice(1)) {
    const end = part.indexOf(CLOSE);
    if (end === -1) {
      if (part) out.push({ text: part, mark: false }); // unclosed: literal
      continue;
    }
    out.push({ text: part.slice(0, end), mark: true });
    const rest = part.slice(end + CLOSE.length);
    if (rest) out.push({ text: rest, mark: false });
  }
  return out;
}
```

`web/src/components/SearchModal.tsx`:
```tsx
// pattern: Imperative Shell
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { SearchPayload } from "../api/payloads";
import { parseSnippet } from "../grammar/snippet";
import { pagePath } from "../paths";

interface ResultRow {
  key: string;
  title: string;          // navigation target (page title)
  label: string;
  snippet: string | null; // block hits only
}

function toRows(p: SearchPayload): ResultRow[] {
  const pages: ResultRow[] = p.pages.map((h) => ({
    key: `p-${h.id}`, title: h.title, label: h.title, snippet: null,
  }));
  const blocks: ResultRow[] = p.blocks.map((h) => ({
    key: `b-${h.uid}`, title: h.page_title, label: h.page_title, snippet: h.snippet,
  }));
  return [...pages, ...blocks]; // pages ranked first, then block snippets
}

export function SearchModal({ open, onClose }:
    { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setRows([]);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setRows([]);
      setSelected(0);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<SearchPayload>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((p) => { setRows(toRows(p)); setSelected(0); })
        .catch(() => setRows([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const go = (row: ResultRow) => {
    onClose();
    navigate(pagePath(row.title));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && rows[selected]) {
      go(rows[selected]);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="search-input" placeholder="Search…"
               value={query} onKeyDown={onKeyDown}
               onChange={(e) => setQuery(e.target.value)} />
        <ul className="search-results">
          {rows.map((row, i) => (
            <li key={row.key}
                className={"search-result" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => go(row)}>
              <span className="result-page">{row.label}</span>
              {row.snippet !== null && (
                <span className="result-snippet">
                  {parseSnippet(row.snippet).map((part, j) =>
                    part.mark
                      ? <mark key={j}>{part.text}</mark>
                      : <span key={j}>{part.text}</span>)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

`web/src/App.tsx` (full replacement — adds search state, Cmd-K, nav button):
```tsx
// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { SearchModal } from "./components/SearchModal";
import { Journal } from "./views/Journal";
import { PageView } from "./views/PageView";

export function App() {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="app">
      <nav className="left-nav">
        <div className="nav-title">pkm</div>
        <Link to="/" className="nav-link">Daily Notes</Link>
        <button className="nav-link search-button"
                onClick={() => setSearchOpen(true)}>
          Search
        </button>
      </nav>
      <main className="main-pane">
        <Routes>
          <Route path="/" element={<Journal />} />
          <Route path="/page/*" element={<PageView />} />
        </Routes>
      </main>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
```

Append to `web/src/styles.css`:
```css
/* search modal */
.modal-overlay { position: fixed; inset: 0; background: rgba(16, 22, 26, 0.4);
  display: flex; justify-content: center; align-items: flex-start;
  padding-top: 12vh; z-index: 20; }
.search-modal { width: min(560px, 90vw); background: #fff; border-radius: 6px;
  box-shadow: 0 8px 32px rgba(16, 22, 26, 0.3); overflow: hidden; }
.search-input { width: 100%; border: none; outline: none; padding: 14px 16px;
  font-size: 16px; border-bottom: 1px solid #e1e8ed; }
.search-results { list-style: none; margin: 0; padding: 4px 0;
  max-height: 50vh; overflow-y: auto; }
.search-result { padding: 6px 16px; cursor: pointer; display: flex;
  flex-direction: column; }
.search-result.selected { background: #ebf1f5; }
.result-page { font-weight: 600; }
.result-snippet { font-size: 13px; color: #5c7080; }
.result-snippet mark { background: #fff3b8; padding: 0 1px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: cmd-k search modal with safe snippet rendering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 10: Live `{{[[query]]}}` blocks

The tokenizer (Task 3) already extracts the balanced-brace expression from `{{[[query]]: …}}` and `{{query: …}}`; this task swaps the inert `.query-pending` span for a component that evaluates it via `GET /api/query?expr=…` (server handles and/or/not incl. nesting), renders blocks grouped by page, shows the total, and paginates with limit/offset.

**Files:**
- Create: `web/src/components/QueryBlock.tsx`
- Modify: `web/src/components/InlineSegments.tsx` (query segment → `<QueryBlock>`), `web/src/styles.css` (append)
- Test: `web/src/components/QueryBlock.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `BlockGroup`/`GroupsPayload` (T2), `mergeGroups` (T7), `tokenizeBlock` (T3), `InlineSegments`/`PageLink` (T4).
- Produces: `QueryBlock({ expr }: { expr: string })` — fetches on mount (limit 20), header shows the raw expr + total count, groups by page, "show more" advances offset by items received and merges groups.

- [ ] **Step 1: Write the failing tests**

`web/src/components/QueryBlock.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { QueryBlock } from "./QueryBlock";

afterEach(() => vi.unstubAllGlobals());

const EXPR = "{and: [[Generative Models]] [[Link]]}";
const ENC = encodeURIComponent(EXPR);

it("evaluates on mount, groups by page, shows the total, paginates", async () => {
  const fetchMock = stubFetch([
    [`/api/query?expr=${ENC}&limit=20&offset=1`, {
      groups: [{ page_id: 7, page_title: "July 1st, 2026", items: [
        { uid: "uid_q2", text: "second [[Link]]" }] }],
      total: 2,
    }],
    [`/api/query?expr=${ENC}`, {
      groups: [{ page_id: 6, page_title: "Generative Models", items: [
        { uid: "uid_q1", text: "a [[Link]] here" }] }],
      total: 2,
    }],
  ]);
  render(<MemoryRouter><QueryBlock expr={EXPR} /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Generative Models" })).toBeInTheDocument();
  expect(screen.getByText("2 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/query?expr=${ENC}&limit=20&offset=0`, undefined);
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByRole("link", { name: "July 1st, 2026" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("InlineSegments renders query segments as live QueryBlocks", async () => {
  stubFetch([[`/api/query?expr=${ENC}`, { groups: [], total: 0 }]]);
  render(
    <MemoryRouter>
      <InlineSegments segments={tokenizeBlock(`{{[[query]]: ${EXPR}}}`)} />
    </MemoryRouter>,
  );
  expect(await screen.findByText("0 results")).toBeInTheDocument();
  expect(screen.getByText(`query: ${EXPR}`)).toBeInTheDocument();
});

it("shows the server's 400 as an error state", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "bad query" }), { status: 400 })));
  render(<MemoryRouter><QueryBlock expr="{nonsense" /></MemoryRouter>);
  expect(await screen.findByText(/400/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/components/QueryBlock.test.tsx`
Expected: FAIL — cannot resolve `./QueryBlock`; the InlineSegments test finds the inert `.query-pending` span instead of "0 results".

- [ ] **Step 3: Implement**

`web/src/components/QueryBlock.tsx`:
```tsx
// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { BlockGroup, GroupsPayload } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";
import { mergeGroups } from "./groups";

const PAGE_SIZE = 20;

export function QueryBlock({ expr }: { expr: string }) {
  const [groups, setGroups] = useState<BlockGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (from: number) => {
    setLoading(true);
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/query?expr=${encodeURIComponent(expr)}&limit=${PAGE_SIZE}&offset=${from}`);
      setGroups((g) => (from === 0 ? p.groups : mergeGroups(g, p.groups)));
      setTotal(p.total);
      setOffset(from + p.groups.reduce((n, gr) => n + gr.items.length, 0));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setGroups([]);
    setTotal(null);
    setOffset(0);
    setError(null);
    void load(0);
    // load(0) reads only `expr` from scope; re-run on expr change alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr]);

  return (
    <div className="query-block">
      <div className="query-header">
        <span className="query-expr">query: {expr}</span>
        {total !== null && (
          <span className="query-total">
            {total} result{total === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {groups.map((g) => (
        <div className="query-group" key={g.page_id}>
          <div className="group-title"><PageLink title={g.page_title} tag={false} /></div>
          {g.items.map((item) => (
            <div className="query-item" key={item.uid}>
              <InlineSegments segments={tokenizeBlock(item.text)} />
            </div>
          ))}
        </div>
      ))}
      {total !== null && offset < total && (
        <button className="show-more" onClick={() => void load(offset)} disabled={loading}>
          {loading ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
```

In `web/src/components/InlineSegments.tsx`: add `import { QueryBlock } from "./QueryBlock";` and replace the `query` case:
```tsx
    case "query":
      return <QueryBlock expr={seg.expr} />;
```
(InlineSegments keeps its `// pattern: Functional Core` header — it still only composes; the fetching lives in QueryBlock.)

Append to `web/src/styles.css`:
```css
/* query blocks */
.query-block { border: 1px solid #e1e8ed; border-radius: 4px; padding: 8px 12px;
  margin: 4px 0; }
.query-header { display: flex; justify-content: space-between; font-size: 12px;
  color: #8a9ba8; margin-bottom: 4px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all PASS (the Task 4 test asserted `pre.code-block` etc., not the pending span, so nothing else breaks); tsc clean.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: live query blocks grouped by page with pagination

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 11: Shift-click right sidebar stack + responsive CSS

Shift-clicking any `PageLink` pushes a panel onto a right sidebar stack (newest on top). Each panel fetches its own page payload and renders title + BlockTree (no backlinks in panels), with a per-panel close button. Plain-CSS responsive: the sidebar becomes an overlay under 900px; under 600px the left nav hides behind a hamburger. Phone is view-only by construction — plan 4 ships no editing surface at all.

**Files:**
- Create: `web/src/components/SidebarPanel.tsx`
- Modify: `web/src/App.tsx` (SidebarContext provider, stack state, hamburger), `web/src/styles.css` (append)
- Test: `web/src/components/SidebarPanel.test.tsx`, `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `SidebarContext`/`SidebarApi` (T4 — every PageLink already calls `openInSidebar` on shift-click), `apiFetch`, `PagePayload` (T2), `BlockTree` (T5), `BlockRefContext` (T4).
- Produces:
  - `SidebarPanel({ title, onClose }: { title: string; onClose: () => void })`
  - App provides `SidebarContext`; stack entries get monotonic ids (a title can be stacked twice); newest entry renders first (top)

- [ ] **Step 1: Write the failing tests**

`web/src/components/SidebarPanel.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { block, pagePayload, stubFetch } from "../test-helpers";
import { SidebarPanel } from "./SidebarPanel";

afterEach(() => vi.unstubAllGlobals());

it("fetches its page and renders title plus block tree, no backlinks", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "a paper block")], {
    backlinks: { groups: [{ page_id: 1, page_title: "Machine Learning", items: [
      { uid: "uid_b3", text: "should not render", breadcrumbs: [] }] }],
      total_pages: 1, offset: 0, limit: 20 },
  })]]);
  render(<MemoryRouter><SidebarPanel title="Paper" onClose={() => undefined} /></MemoryRouter>);
  expect(await screen.findByText("a paper block")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.queryByText("should not render")).toBeNull();
});

it("close button fires onClose", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [])]]);
  const onClose = vi.fn();
  render(<MemoryRouter><SidebarPanel title="Paper" onClose={onClose} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "close panel" }));
  expect(onClose).toHaveBeenCalledOnce();
});
```

`web/src/App.test.tsx`:
```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { block, pagePayload, stubFetch } from "./test-helpers";
import { App } from "./App";

class NoopObserver {
  constructor(_cb: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NoopObserver));
afterEach(() => vi.unstubAllGlobals());

it("shift-click stacks sidebar panels newest-first; close removes one", async () => {
  stubFetch([
    ["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "paper body")])],
    ["/api/page/AI", pagePayload("AI", [block("uid_s2", "ai body")])],
    ["/api/page/Machine%20Learning", pagePayload("Machine Learning", [
      block("uid_m1", "see [[Paper]] and [[AI]]")])],
  ]);
  render(
    <MemoryRouter initialEntries={["/page/Machine%20Learning"]}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(await screen.findByText("paper body")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "AI" }), { shiftKey: true });
  expect(await screen.findByText("ai body")).toBeInTheDocument();

  const panels = screen.getAllByRole("region"); // section elements with aria-label
  expect(within(panels[0]).getByText("ai body")).toBeInTheDocument(); // newest on top

  fireEvent.click(within(panels[0]).getByRole("button", { name: "close panel" }));
  expect(screen.queryByText("ai body")).toBeNull();
  expect(screen.getByText("paper body")).toBeInTheDocument();
});

it("cmd-k opens the search modal", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(await screen.findByPlaceholderText("Search…")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run src/components/SidebarPanel.test.tsx src/App.test.tsx`
Expected: FAIL — cannot resolve `./SidebarPanel`; shift-click currently hits the default no-op context, so no panel appears.

- [ ] **Step 3: Implement**

`web/src/components/SidebarPanel.tsx`:
```tsx
// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { encodeTitle } from "../paths";
import { BlockTree } from "./BlockTree";
import { PageLink } from "./PageLink";

export function SidebarPanel({ title, onClose }:
    { title: string; onClose: () => void }) {
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title]);

  return (
    <section className="sidebar-panel" aria-label={`sidebar: ${title}`}>
      <header className="sidebar-panel-header">
        <h2 className="sidebar-panel-title"><PageLink title={title} tag={false} /></h2>
        <button className="panel-close" onClick={onClose} aria-label="close panel">
          ×
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {!payload && !error && <p className="loading">Loading…</p>}
      {payload && (
        <BlockRefContext.Provider value={payload.block_ref_texts}>
          <BlockTree blocks={payload.blocks} />
        </BlockRefContext.Provider>
      )}
    </section>
  );
}
```

`web/src/App.tsx` (full replacement — final form):
```tsx
// pattern: Imperative Shell
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { SearchModal } from "./components/SearchModal";
import { SidebarPanel } from "./components/SidebarPanel";
import { SidebarContext } from "./contexts";
import { Journal } from "./views/Journal";
import { PageView } from "./views/PageView";

interface SidebarEntry {
  id: number; // monotonic: the same title can be stacked twice
  title: string;
}

export function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [stack, setStack] = useState<SidebarEntry[]>([]);
  const idRef = useRef(1);

  const sidebarApi = useMemo(() => ({
    openInSidebar: (title: string) => {
      const id = idRef.current;
      idRef.current += 1;
      setStack((s) => [{ id, title }, ...s]); // newest on top
    },
  }), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <SidebarContext.Provider value={sidebarApi}>
      <div className="app">
        <button className="hamburger" aria-label="menu"
                onClick={() => setNavOpen((o) => !o)}>
          ☰
        </button>
        <nav className={"left-nav" + (navOpen ? " open" : "")}>
          <div className="nav-title">pkm</div>
          <Link to="/" className="nav-link" onClick={() => setNavOpen(false)}>
            Daily Notes
          </Link>
          <button className="nav-link search-button"
                  onClick={() => { setNavOpen(false); setSearchOpen(true); }}>
            Search
          </button>
        </nav>
        <main className="main-pane">
          <Routes>
            <Route path="/" element={<Journal />} />
            <Route path="/page/*" element={<PageView />} />
          </Routes>
        </main>
        {stack.length > 0 && (
          <aside className="sidebar">
            {stack.map((entry) => (
              <SidebarPanel
                key={entry.id}
                title={entry.title}
                onClose={() => setStack((s) => s.filter((e) => e.id !== entry.id))}
              />
            ))}
          </aside>
        )}
        <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </SidebarContext.Provider>
  );
}
```

Append to `web/src/styles.css`:
```css
/* right sidebar stack */
.sidebar { width: 340px; flex-shrink: 0; border-left: 1px solid #e1e8ed;
  background: #fbfcfd; padding: 16px; overflow-y: auto; height: 100vh;
  position: sticky; top: 0; }
.sidebar-panel { border-bottom: 1px solid #e1e8ed; padding-bottom: 12px;
  margin-bottom: 12px; }
.sidebar-panel-header { display: flex; justify-content: space-between;
  align-items: baseline; }
.sidebar-panel-title { font-size: 17px; margin: 0 0 8px; }
.panel-close { background: none; border: none; cursor: pointer;
  color: #8a9ba8; font-size: 16px; }
.hamburger { display: none; position: fixed; top: 10px; left: 10px; z-index: 30;
  background: #fff; border: 1px solid #d8e1e8; border-radius: 4px;
  padding: 4px 8px; cursor: pointer; }

/* responsive: sidebar overlays under 900px */
@media (max-width: 900px) {
  .sidebar { position: fixed; right: 0; top: 0; height: 100vh;
    box-shadow: -4px 0 16px rgba(16, 22, 26, 0.2); z-index: 10; }
}

/* phone (<600px): nav behind a hamburger; view-only by construction */
@media (max-width: 600px) {
  .hamburger { display: block; }
  .left-nav { position: fixed; left: 0; top: 0; height: 100vh; z-index: 25;
    transform: translateX(-100%); transition: transform 0.15s; }
  .left-nav.open { transform: translateX(0); }
  .main-pane { padding: 48px 16px 120px; }
  .sidebar { width: 100vw; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test -- --run && pnpm typecheck && pnpm build`
Expected: all PASS; tsc clean; production build succeeds.

- [ ] **Step 5: Commit and push**

```bash
git add web/ && git commit -m "feat: shift-click sidebar stack and responsive layout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 12: Serve the built SPA from FastAPI (`web_dist` config + catch-all)

`Config` gains optional `web_dist: Path | None` (config key `web_dist`, resolved relative to the config file, default None; `setup.py` writes it when `--web-dist` is given). When set, `create_app` mounts StaticFiles at `/app-assets` (Vite's `build.assetsDir` is already `app-assets`, so built asset URLs never collide with the API's `/assets/{sha256}/{filename}` route) and registers a catch-all `GET /{full_path:path}` LAST that returns `index.html` for any non-API path. Registration order keeps `/healthz`, `/login`, `/api/*`, `/assets/*` winning; the catch-all additionally 404s unknown `api/`, `assets/`, `app-assets/` prefixes so a typo'd API URL never gets HTML.

**Files:**
- Modify: `server/src/pkm/server/config.py`, `server/src/pkm/server/setup.py`, `server/src/pkm/server/app.py`
- Test: `server/tests/test_spa.py`

**Interfaces:**
- Consumes: built `web/dist/` layout (`index.html` + `app-assets/`), existing `create_app`/`Config`/`load_config`.
- Produces:
  - `Config.web_dist: Path | None = None`; `load_config` resolves `raw["web_dist"]` against the config file's directory when present
  - `python -m pkm.server.setup --data-dir DIR --password PW [--web-dist REL]` writes the key only when given
  - With `web_dist` set: `GET /` and any non-API path → `index.html` (no auth: the static shell holds no data; the app's first API call 401s and redirects to `/login`); `GET /app-assets/…` → static files. Without it: `/` stays 404 as today.

- [ ] **Step 1: Write the failing tests**

`server/tests/test_spa.py`:
```python
import json

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.config import Config, load_config
from pkm.server.setup import main as setup_main


def _dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "app-assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><div id=\"root\"></div>", encoding="utf-8")
    (dist / "app-assets" / "main.js").write_text(
        "console.log('pkm')", encoding="utf-8")
    return dist


def _config(tmp_path, web_dist=None) -> Config:
    return Config(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
        web_dist=web_dist,
    )


def test_spa_served_when_web_dist_set(tmp_path):
    client = TestClient(create_app(_config(tmp_path, web_dist=_dist(tmp_path))))
    r = client.get("/")
    assert r.status_code == 200
    assert "<!doctype html" in r.text
    deep = client.get("/page/Machine%20Learning")  # client-side route
    assert deep.status_code == 200 and deep.text == r.text
    js = client.get("/app-assets/main.js")
    assert js.status_code == 200
    assert "javascript" in js.headers["content-type"]


def test_api_and_asset_routes_not_shadowed(tmp_path):
    client = TestClient(create_app(_config(tmp_path, web_dist=_dist(tmp_path))))
    assert client.get("/healthz").json() == {"ok": True}
    assert client.get("/api/search", params={"q": "x"}).status_code == 401
    assert client.get("/login").status_code == 200  # login page, not index.html
    # unknown api/assets paths 404 rather than returning HTML
    assert client.get("/api/nonexistent").status_code == 404
    assert client.get("/assets/not-a-sha").status_code == 404


def test_without_web_dist_root_is_404(tmp_path):
    client = TestClient(create_app(_config(tmp_path)))
    assert client.get("/").status_code == 404


def test_load_config_resolves_web_dist_relative(tmp_path):
    cfg = {"db_file": "pkm.sqlite3", "assets_dir": "assets",
           "password_salt": "00" * 16, "password_hash": "ab" * 32,
           "session_secret": "cd" * 32, "web_dist": "../web/dist"}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    loaded = load_config(path)
    assert loaded.web_dist == tmp_path / "../web/dist"
    cfg.pop("web_dist")
    path.write_text(json.dumps(cfg), encoding="utf-8")
    assert load_config(path).web_dist is None


def test_setup_writes_web_dist_only_when_given(tmp_path):
    assert setup_main(["--data-dir", str(tmp_path / "a"), "--password", "pw",
                       "--insecure-cookie", "--web-dist", "../web/dist"]) == 0
    cfg = load_config(tmp_path / "a" / "config.json")
    assert cfg.web_dist == tmp_path / "a" / "../web/dist"
    assert cfg.cookie_secure is False
    assert setup_main(["--data-dir", str(tmp_path / "b"),
                       "--password", "pw"]) == 0
    assert load_config(tmp_path / "b" / "config.json").web_dist is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_spa.py -v`
Expected: FAIL — `TypeError: Config.__init__() got an unexpected keyword argument 'web_dist'`.

- [ ] **Step 3: Implement**

`server/src/pkm/server/config.py` — add the field and the load branch:
```python
@dataclass(frozen=True)
class Config:
    db_path: Path
    assets_dir: Path
    password_salt: str   # hex
    password_hash: str   # hex (scrypt)
    session_secret: str  # hex
    cookie_secure: bool = True
    web_dist: Path | None = None  # built SPA dir; None = API-only server


def load_config(path: Path) -> Config:
    raw = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    return Config(
        db_path=base / raw["db_file"],
        assets_dir=base / raw["assets_dir"],
        password_salt=raw["password_salt"],
        password_hash=raw["password_hash"],
        session_secret=raw["session_secret"],
        cookie_secure=raw.get("cookie_secure", True),
        web_dist=(base / raw["web_dist"]) if raw.get("web_dist") else None,
    )
```

`server/src/pkm/server/setup.py` — add after the `--insecure-cookie` argument:
```python
    ap.add_argument("--web-dist",
                    help="path to the built SPA dist dir, relative to the"
                         " data dir (e.g. ../web/dist); omit for API-only")
```
and after the `cfg = {…}` dict literal:
```python
    if args.web_dist:
        cfg["web_dist"] = args.web_dist
```

`server/src/pkm/server/app.py` — extend the imports:
```python
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
```
and in `create_app`, AFTER the `healthz` route definition and immediately before `return app` (last registration wins the lowest priority — every earlier route still matches first):
```python
    if config.web_dist is not None:
        app.mount("/app-assets",
                  StaticFiles(directory=config.web_dist / "app-assets"),
                  name="app-assets")
        index_html = config.web_dist / "index.html"

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            # Real API/asset routes are registered earlier and win; anything
            # still hitting these prefixes is a miss, not a client-side route.
            if full_path.startswith(("api/", "assets/", "app-assets/")):
                raise HTTPException(status_code=404, detail="not found")
            return FileResponse(index_html)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_spa.py -v`
Expected: all PASS. Full suite: `uv run pytest -q` → all pass (existing tests construct Config without `web_dist`; the default keeps them green).

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: serve built SPA from fastapi via optional web_dist config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

### Task 13: Real-data smoke test (verification)

**Requires:** the imported database at `data/pkm.sqlite3`. This run is read-only against the real data — the only sanctioned mutation is the journal's auto-create of today's page (pre-existing read-route behaviour). `data/config.json` is created for the run and DELETED afterwards (it must never enter git; abort if one already exists). Visual verification in a real browser (rendering fidelity, sidebar feel, phone layout) happens outside this plan's script — note whatever the curls can't cover as follow-ups.

- [ ] **Step 1: Build the SPA and generate a temporary config**

```bash
test ! -f data/config.json || { echo "data/config.json already exists — aborting"; exit 1; }
cd web && pnpm build && cd ..
cd server && uv run python -m pkm.server.setup --data-dir ../data \
  --password pkm-smoke --insecure-cookie --web-dist ../web/dist
```

Expected: `web/dist/index.html` + `web/dist/app-assets/*.js` exist; `wrote ../data/config.json`.

- [ ] **Step 2: Run the server and exercise it with curl**

Start (background): `cd server && uv run python -m pkm.server.run --data-dir ../data --port 8974`

Then:
```bash
BASE=http://127.0.0.1:8974
COOKIES=/tmp/pkm-smoke-cookies.txt
for i in $(seq 1 20); do curl -sf $BASE/healthz >/dev/null && break; sleep 0.5; done
curl -sf $BASE/healthz                                      # {"ok":true}

# SPA shell is served, client-side routes fall through to index.html
curl -s $BASE/ | head -c 200                                # <!doctype html…
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/page/Paper")" = "200"
JS=$(curl -s $BASE/ | grep -o '/app-assets/[^"]*\.js' | head -1)
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$JS")" = "200"

# API stays gated without a cookie
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/search?q=test")" = "401"

# login, then read a real page through the cookie
curl -sf -c $COOKIES -X POST $BASE/api/login \
  -H 'Content-Type: application/json' -d '{"password":"pkm-smoke"}'
curl -sf -b $COOKIES "$BASE/api/page/Paper" | head -c 400   # page+blocks+backlinks JSON
curl -sf -b $COOKIES "$BASE/api/journal?days=3" | head -c 400
curl -sf -b $COOKIES "$BASE/api/search?q=datascript" | head -c 300
echo SMOKE-CURLS-OK
```

Expected: every `test`/`curl -sf` succeeds; the `/api/page/Paper` body contains `"backlinks"` with populated groups (423 refs on this page in the real graph). If anything fails, STOP and investigate before touching the data or the code.

- [ ] **Step 3: Tear down**

Kill the background server, then:
```bash
rm ../data/config.json /tmp/pkm-smoke-cookies.txt
```
Confirm `git status` shows no `data/` files staged or untracked-but-addable (the directory is gitignored; this is belt-and-braces).

- [ ] **Step 4: Record findings**

Append a `### Frontend-read smoke findings (plan 4)` subsection to `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` (after the plan-3 findings): SPA serving behaviour on the real data (index.html catch-all, asset JS, auth gating), anything surprising in the curls, bundle size from `pnpm build` output, and an explicit note that in-browser visual verification (rendering fidelity on heavy real pages, sidebar stack, phone breakpoints) is deferred to manual use / plan 5's Playwright smoke.

- [ ] **Step 5: Commit and push**

```bash
git add docs/ && git commit -m "docs: record frontend-read smoke findings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN" && git push
```

---

## Self-review notes (completed)

- **Spec coverage (plan-4 scope):** app shell + routing + auth-redirect ✓ (T2 apiFetch 401→/login, T6 shell); TS grammar core passing the shared fixture ✓ (T3, order-sensitive `toEqual` against all 11 cases, semantics mirrored from refs.py: code stripped first via same regexes, attribute at block start only, `#tag` charset, nested `[[…]]` outer-then-inner, dedupe by (title,kind), uid `[a-zA-Z0-9_-]{6,}`); rendering constructs from the real-graph facts ✓ (T3/T4: fences+lang, inline code, `[[Page]]` incl. nested, `#tag`/`#[[Long Tag]]`, `Attr::`, `((uid))` with `block_ref_texts` resolution + literal fallback, bold/italic/strike/highlight, `/assets/` images + external images, markdown links, `/assets/*.pdf` → embed+download, TODO/DONE checkboxes read-only, `{{[[query]]:}}` + `{{query:}}` balanced-brace, multi-line linebreaks); block/outline with headings h1–h3, `collapsed` initial state + client toggle ✓ (T5); page view with backlinks below (same payload, breadcrumb trail, show-more via `bl_offset`) + unlinked refs collapsed-by-default lazy fetch ✓ (T7); journal home, newest-first, `before`-exclusive infinite scroll ✓ (T8); Cmd-K search, pages-then-snippets, `<mark>` split — no dangerouslySetInnerHTML for server text ✓ (T9); live query blocks grouped by page with total + pagination ✓ (T10); shift-click sidebar stack, newest-on-top, per-panel close, no backlinks in panels; responsive overlay <900px, hamburger <600px, phone view-only ✓ (T11); FastAPI serves the SPA (`web_dist`, `/app-assets` mount, catch-all last, `/` 404 without config) ✓ (T12); real-data smoke ✓ (T13). Plan-3 carryovers all in T1 (TypeAdapter, TouchPage arm, isascii, ws finally, heading Field bounds + 422 test, WS 4401 assert) plus `openapi_dump`. Every list the UI renders is bounded (backlinks/unlinked/query show-more, journal batches, search server-limited). Out of scope, stated: editing/ops-sending, phone composer, WS consumption (plan 5); `:page/sidebar` nav shortcuts (not imported); creating block refs.
- **Type-consistency check (the #1 failure mode):** `apiFetch<T>(path, init?)` — call sites in T6/T7/T8/T9/T10/T11 all pass a single path string (fetch asserted with `, undefined)` in tests) ✓. `InlineSegments({ segments: BlockSegment[]; depth?: number })` — callers pass `tokenizeBlock(...)` output everywhere; emphasis `children: InlineSegment[]` re-enter the same component ✓. Segment kinds used by the renderer switch exactly match the T3 union (`text/linebreak/inline-code/page-ref/attribute/block-ref/image/link/bold/italic/strike/highlight/todo/code-block/query`) ✓. `BlockRef({ uid, depth })` matches the `block-ref` case; `MAX_DEPTH` guards payload-level circular refs ✓. Context names `SidebarContext`/`BlockRefContext` and `SidebarApi.openInSidebar(title)` identical in T4 (definition + PageLink), T7 (BacklinksSection provider), T11 (App provider, panel provider) ✓. `Backlinks.total_pages` (page endpoint) vs `GroupsPayload.total` (unlinked/query) deliberately kept distinct — matches the server payloads; the plan-3 note about normalizing the naming was resolved by NOT touching API semantics (locked) and encoding both names in `payloads.ts`. `pagePath`/`encodeTitle`/`titleFromPathname` used consistently (nav links, API paths, splat decoding); journal link test pins `/page/July%208th%2C%202026` (comma encodes, slash wouldn't) ✓. Server: `Config(web_dist=...)` keyword-only-with-default keeps every existing constructor call green; `openapi_dump.main()` uses the same dummy hex strings as conftest ✓. Test seed shapes copy routes_pages.py exactly (`page/blocks/backlinks{groups,total_pages,offset,limit}/block_ref_texts`, journal `days[{date,title,exists,blocks}]`, search `pages/blocks{uid,page_title,snippet}`, groups `{groups[{page_id,page_title,items[{uid,text}]}],total}`) ✓.
- **Placeholder scan:** clean — every step contains complete, runnable code and exact commands; no TBDs; the two intentionally-superseded spots (T6's `/` route element, T4's `.query-pending` span) ship as real working code and are replaced by named later tasks (T8, T10), not left as gaps. App.tsx is shown in FULL at each of its four revisions (T2, T6, T9, T11) rather than described by delta-reference.
- **Judgement calls made while writing (recorded for the reviewer):** (1) response payload types are hand-pinned in `payloads.ts` because the read routes return untyped dicts — the generated `types.d.ts` only carries request models; (2) apiFetch's 401 redirect goes through an injectable handler (`setUnauthorizedHandler`) because jsdom's `location` is unforgeable — default behaviour is still `window.location.href = "/login"`; (3) the TS tag charset is `[\p{L}\p{N}_./\-]` to mirror Python's unicode-aware `\w`; (4) emphasis kinds share one union member so `{kind, children}` typechecks without casts; (5) BlockRef renders resolved text through the grammar with a depth cap of 3 (payloads can contain mutually-referencing texts); (6) highlight.js loads via `highlight.js/lib/common` (bundle size) and its generated HTML is the sole `dangerouslySetInnerHTML` use; (7) journal auto-scroll stops after 3 consecutive all-empty batches and degrades to a manual button; (8) TODO/DONE accepts both `{{[[TODO]]}}` and `{{TODO}}` spellings; (9) the SPA catch-all 404s unknown `api/`/`assets/`/`app-assets/` prefixes instead of serving HTML; (10) `mergeGroups` merges pagination batches by `page_id` so a page spanning two batches doesn't render two headers.

