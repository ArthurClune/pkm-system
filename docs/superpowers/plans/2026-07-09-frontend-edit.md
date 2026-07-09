# Frontend Edit Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The write half of the PKM frontend: the Roam-style outliner (focused block is a live textarea, everything else rendered HTML) with the full keyboard editing loop (Enter split, Tab/Shift-Tab indent/outdent, Alt-↑/↓ move, arrows crossing blocks, Esc blur), `[[`/`#` page-title autocomplete, persisted collapse + clickable TODO checkboxes, optimistic op batches to `POST /api/ops`, live WebSocket consumption (other clients patch in, "Reconnecting…" pauses writes), paste/drop image upload, the phone bottom composer, and a Playwright smoke of the core editing loop. Plus the plan-4 carry-forwards (OpenAPI drift guard first) and the plan-3 non-blocking-broadcast carry-forward.

**Architecture:** A pure TS outline core (`web/src/outline/`) turns each editing gesture into the exact server op batch and applies those ops to the local block tree via one `applyOps` function that mirrors `ops_apply.py` semantics (ShiftSiblings gaps and all) — the same function patches in remote WebSocket batches, so local echo and remote sync cannot diverge from each other. Thin imperative shells own the network: a serializing op queue (one POST in flight, failed batch ⇒ refetch authoritative state) and a reconnecting `/api/ws` client exposed through a `SyncProvider` context. Server changes are minimal and early: expose `order_idx` in the read payload (the editor MUST address moves in the server's frame of reference), a `GET /api/titles` autocomplete endpoint, and the non-blocking broadcast. Spec: `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` Sections 3, 4 + the plan-3 contract notes and plan-4 carry-forwards recorded there. **This is plan 5 of 6** (import ✅ → read API ✅ → write path/sync ✅ → frontend read ✅ → frontend edit → deployment).

**Tech Stack:** Existing web stack (pnpm, Vite 6, React 18, TS strict, react-router v6, vitest + @testing-library/react + jsdom) plus `@playwright/test` (dev). No new runtime dependencies — uids come from a 10-line `crypto.getRandomValues` helper, not nanoid. Server side: existing Python ≥3.12 / FastAPI via `uv`.

## Global Constraints

- All web commands run from `web/` via pnpm; vitest non-watch runs are `pnpm test -- --run`; `pnpm typecheck` (strict tsc) must pass before every web commit. All server commands run from `server/` via `uv run …`.
- FCIS headers: every runtime `.py`/`.ts`/`.tsx` file carries `# pattern: …` / `// pattern: Functional Core` or `// pattern: Imperative Shell`. Components that only render props are Functional Core; anything fetching/DOM-side-effecting/socketed is Imperative Shell. Tests, configs, and type-only files are exempt.
- TypeScript strict; no `any` (tests may use `as unknown as T` bridges where jsdom typing forces it).
- **`POST /api/ops` is the only write path** — no other route may mutate blocks. Existing route response shapes and semantics must not change EXCEPT the sanctioned additions in T1/T2: `order_idx` added to tree nodes in page/journal payloads, and the new `GET /api/titles` route.
- **`MoveOp.order_idx` frame of reference (plan-3 contract note):** "insert before the block currently at `order_idx`, counted BEFORE the moved block is removed". Sibling shifts leave gaps; readers order by `order_idx`. The outline core must therefore always read real `order_idx` values off the tree — never array positions.
- **No offline editing (spec):** while the WebSocket is down the UI shows "Reconnecting…" and writes are paused (`readOnly` editors, disabled composer). Divergence impossible rather than merged. Per-block last-write-wins; no versions.
- The two generated files `web/src/api/openapi.json` and `web/src/api/types.d.ts` ARE committed and, from T1 on, guarded by a server test — any server model/route change must regenerate them in the same commit (`uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `pnpm gen-types`).
- FTS `<mark>` snippets stay split-rendered; never `dangerouslySetInnerHTML` for server text.
- The UI never renders unbounded lists (unchanged from plan 4).
- Never commit `data/` or `sample-data/`; `web/node_modules/`, `web/dist/`, `web/test-results/`, `web/playwright-report/` are gitignored.
- Commit after each green test cycle; push after committing. End commit messages with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN
```

## File Structure

```
server/
  src/pkm/server/
    ws.py                    # T1: non-blocking broadcast (SEND_TIMEOUT + wait_for)
    tree.py                  # T1: expose order_idx in tree nodes
    routes_search.py         # T2: + GET /api/titles
  tests/
    test_ws.py               # T1: broadcast drop test
    test_openapi_sync.py     # T1: NEW — committed openapi.json == live schema
    test_tree.py             # T1: order_idx assertion
    test_titles_endpoint.py  # T2: NEW
    e2e_serve.py             # T13: NEW — scratch server bootstrap for Playwright
web/
  vite.config.ts             # T7: ws proxy; T13: exclude e2e/ from vitest
  package.json               # T13: @playwright/test, "e2e" script
  playwright.config.ts       # T13: NEW
  e2e/edit.spec.ts           # T13: NEW
  src/
    styles.css               # T3/T7/T8/T9/T12: appended sections
    main.tsx                 # T3: ErrorBoundary wrap
    App.tsx                  # T3: NotFound route; T7: SyncProvider + banner
    contexts.ts              # T8: + BlockEditContext
    test-helpers.ts          # T1: block() order_idx; T7: FakeWebSocket; T10: makeSync
    test-setup.ts            # T7: stub global WebSocket
    uid.ts                   # T4: NEW — FC: newUid()
    api/
      payloads.ts            # T1: BlockNode.order_idx; T2: TitlesPayload
      ops.ts                 # T4: NEW — type-only aliases over generated schema
      openapi.json types.d.ts  # T2: regenerated
    grammar/
      todo.ts                # T5: NEW — FC: toggleTodo
    outline/
      tree.ts                # T4: NEW — FC: locate/visibleUids/visibleNeighbor/applyOps
      edits.ts               # T5: NEW — FC: gesture → ops + new tree + focus
      autocomplete.ts        # T9: NEW — FC: detectAutocomplete/applyCompletion
      useOutline.ts          # T10: NEW — IS: state + handlers + sync wiring hook
    sync/
      opQueue.ts             # T6: NEW — IS: clientId + serializing queue
      socket.ts              # T7: NEW — IS: reconnecting /api/ws client
      SyncProvider.tsx       # T7: NEW — IS: context {status, enqueue, subscribe, resyncSeq}
      assets.ts              # T11: NEW — IS: uploadAsset + assetMarkdown
    components/
      ErrorBoundary.tsx      # T3: NEW
      InlineSegments.tsx     # T3: href allowlist
      groups.ts              # T3: mergeGroups made generic
      BacklinksSection.tsx   # T3: use mergeGroups
      SearchModal.tsx        # T3: aria-label
      TodoCheckbox.tsx       # T3: aria-label; T8: clickable via BlockEditContext
      ReconnectBanner.tsx    # T7: NEW
      EditableBlockTree.tsx  # T8: NEW — IS: EditableBlock + tree (focus/keyboard)
      AutocompletePopup.tsx  # T9: NEW — IS: useTitleOptions hook + dumb popup
      Composer.tsx           # T12: NEW — IS: phone bottom composer
    views/
      Journal.tsx            # T3: aria-live status; T10: EditablePage per day
      PageView.tsx           # T10: EditablePage + refetch wiring
      EditablePage.tsx       # T10: NEW — IS: useOutline + tree + empty-page affordance
```

Read-only rendering (BlockTree, backlink/unlinked/query sections, SidebarPanel) is untouched and keeps using plan-4's `BlockTree`; only PageView's main outline and the Journal days become editable.

---

### Task 1: Server pre-flight — non-blocking broadcast, OpenAPI drift guard, `order_idx` in read payload

The three "do first" items: the plan-3 carry-forward (a stalled WebSocket client must not block `POST /api/ops` for everyone), the plan-4 "do EARLY in plan 5" drift guard, and exposing `order_idx` so the editor can speak the server's move/create frame of reference (block rows already SELECT it; `build_tree` just drops it today).

**Files:**
- Modify: `server/src/pkm/server/ws.py`
- Modify: `server/src/pkm/server/tree.py`
- Create: `server/tests/test_openapi_sync.py`
- Test: `server/tests/test_ws.py`, `server/tests/test_tree.py`
- Modify: `web/src/api/payloads.ts`, `web/src/test-helpers.ts`

**Interfaces:**
- Consumes: existing `Hub`, `build_tree(rows)`, `create_app(Config)`.
- Produces: `pkm.server.ws.SEND_TIMEOUT: float` module constant; every node dict from `build_tree` gains `"order_idx": int`; TS `BlockNode` gains `order_idx: number` (T4's outline core relies on it); `block()` test helper accepts/defaults `order_idx`.

- [ ] **Step 1: Write the failing broadcast test**

Append to `server/tests/test_ws.py`:

```python
import asyncio


class _GoodWS:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


class _RaisingWS:
    async def send_json(self, message):
        raise RuntimeError("client gone")


class _StallingWS:
    async def send_json(self, message):
        await asyncio.sleep(60)


def test_broadcast_drops_bad_connections_and_still_delivers(monkeypatch):
    from pkm.server import ws as ws_module
    monkeypatch.setattr(ws_module, "SEND_TIMEOUT", 0.05)
    hub = ws_module.Hub()
    good, raising, stalling = _GoodWS(), _RaisingWS(), _StallingWS()
    for conn in (raising, stalling, good):
        hub._conns.add(conn)
    asyncio.run(hub.broadcast({"ok": 1}))
    assert good.sent == [{"ok": 1}]
    assert hub._conns == {good}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_ws.py -v`
Expected: new test FAILS — `AttributeError: module 'pkm.server.ws' has no attribute 'SEND_TIMEOUT'`.

- [ ] **Step 3: Make the broadcast non-blocking**

In `server/src/pkm/server/ws.py`, add `import asyncio` to the imports, add a module constant, and change `broadcast`:

```python
SEND_TIMEOUT = 1.0  # a stalled client is dropped, not waited on


class Hub:
    def __init__(self) -> None:
        self._conns: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._conns.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._conns.discard(ws)

    async def broadcast(self, message: dict) -> None:
        for ws in list(self._conns):
            try:
                await asyncio.wait_for(ws.send_json(message),
                                       timeout=SEND_TIMEOUT)
            except Exception:
                self._conns.discard(ws)
```

- [ ] **Step 4: Run the ws tests**

Run: `cd server && uv run pytest tests/test_ws.py -v`
Expected: all PASS (including the existing broadcast tests).

- [ ] **Step 5: Write the failing drift-guard test**

Create `server/tests/test_openapi_sync.py`:

```python
"""Plan-4 carry-forward: the committed web/src/api/openapi.json (source of the
generated types.d.ts) must match the live schema, or the TS op types the
editor sends with are stale."""
import json
from pathlib import Path

from pkm.server.app import create_app
from pkm.server.config import Config

REGEN = ("regenerate with `uv run python -m pkm.server.openapi_dump "
         "> ../web/src/api/openapi.json` then `pnpm gen-types`, and commit "
         "both files")


def test_committed_openapi_matches_live_schema():
    root = Path(__file__).resolve().parents[2]
    committed = json.loads(
        (root / "web" / "src" / "api" / "openapi.json").read_text())
    config = Config(
        db_path=Path("/nonexistent/pkm.sqlite3"),
        assets_dir=Path("/nonexistent/assets"),
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    assert committed == create_app(config).openapi(), \
        f"web/src/api/openapi.json is stale: {REGEN}"
```

- [ ] **Step 6: Run it**

Run: `cd server && uv run pytest tests/test_openapi_sync.py -v`
Expected: PASS immediately (nothing has drifted yet — the point is it now CAN'T silently). If it fails instead, the dump was already stale: regenerate per the message, commit the regenerated files with this task, and note it.

- [ ] **Step 7: Write the failing order_idx test**

Append to `server/tests/test_tree.py`:

```python
def test_build_tree_exposes_order_idx():
    tree = build_tree(ROWS)
    assert [n["order_idx"] for n in tree] == [0, 1, 0]
    assert tree[1]["children"][0]["order_idx"] == 0
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_tree.py -v`
Expected: FAIL with `KeyError: 'order_idx'`.

- [ ] **Step 9: Expose order_idx**

In `server/src/pkm/server/tree.py`, add one line to the node dict in `nodes()`:

```python
        return [{
            "uid": r["uid"],
            "text": r["text"],
            "heading": r["heading"],
            "collapsed": bool(r["collapsed"]),
            "order_idx": r["order_idx"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "children": nodes(r["uid"]),
        } for r in children]
```

- [ ] **Step 10: Run the full server suite**

Run: `cd server && uv run pytest -q`
Expected: all pass. (Page/journal endpoint tests assert on specific keys, not exact dicts, so the added key is additive. If any exact-dict assertion does fail, add `order_idx` to its expected value — the shape change is sanctioned.)

- [ ] **Step 11: Mirror the shape in TS**

In `web/src/api/payloads.ts`, add `order_idx` to `BlockNode`:

```ts
export interface BlockNode {
  uid: string;
  text: string;
  heading: number | null;
  collapsed: boolean;
  order_idx: number;
  created_at: number | null;
  updated_at: number | null;
  children: BlockNode[];
}
```

In `web/src/test-helpers.ts`, update the `block()` factory defaults:

```ts
export function block(uid: string, text: string,
                      over: Partial<BlockNode> = {}): BlockNode {
  return { uid, text, heading: null, collapsed: false, order_idx: 0,
           created_at: 1000, updated_at: 2000, children: [], ...over };
}
```

- [ ] **Step 12: Typecheck + web tests**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: clean. If any test builds a `BlockNode` literal without the helper, add `order_idx: 0` there (tsc will point at each one).

- [ ] **Step 13: Commit**

```bash
git add server/src/pkm/server/ws.py server/src/pkm/server/tree.py \
  server/tests/test_ws.py server/tests/test_openapi_sync.py server/tests/test_tree.py \
  web/src/api/payloads.ts web/src/test-helpers.ts
git commit -m "feat: non-blocking ws broadcast, openapi drift guard, order_idx in read payload"
git push
```

### Task 2: `GET /api/titles` — page-title autocomplete endpoint

Autocomplete needs reliable substring matching on titles (namespace pages like `AWS/SCP`, mid-word fragments) — FTS tokenization is wrong for that; a `LIKE` over 4.3k titles is sub-millisecond. Prefix matches rank first, then shorter titles. Adding a route changes the OpenAPI schema, so this task also regenerates the two committed files (T1's guard enforces it).

**Files:**
- Modify: `server/src/pkm/server/routes_search.py`
- Create: `server/tests/test_titles_endpoint.py`
- Modify (regenerated): `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Modify: `web/src/api/payloads.ts`

**Interfaces:**
- Consumes: `get_db`, seeded conftest fixtures (`client`, `anon_client`; seed pages: "Machine Learning", "AI", "July 7th, 2026", "Paper", "Attention Is All You Need").
- Produces: `GET /api/titles?q=&limit=` → `{"titles": ["..."]}` — prefix matches first, then substring, shorter-then-alphabetical within each rank; `\`/`%`/`_` treated literally; empty/whitespace `q` → `{"titles": []}`; auth-gated. TS `TitlesPayload { titles: string[] }` (consumed by T9's `useTitleOptions`).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_titles_endpoint.py`:

```python
def test_titles_prefix_ranks_before_substring(client):
    r = client.get("/api/titles", params={"q": "a"})
    assert r.status_code == 200
    # prefix matches ("AI", "Attention…") first, shorter first; then
    # substring matches ("Paper", "Machine Learning") shorter first.
    assert r.json()["titles"] == [
        "AI", "Attention Is All You Need", "Paper", "Machine Learning"]


def test_titles_matches_are_case_insensitive_substrings(client):
    assert client.get("/api/titles", params={"q": "learn"}).json() == {
        "titles": ["Machine Learning"]}


def test_titles_escapes_like_wildcards(client):
    assert client.get("/api/titles", params={"q": "%"}).json() == {"titles": []}
    assert client.get("/api/titles", params={"q": "_"}).json() == {"titles": []}


def test_titles_empty_query_returns_nothing(client):
    assert client.get("/api/titles").json() == {"titles": []}
    assert client.get("/api/titles", params={"q": "  "}).json() == {"titles": []}


def test_titles_requires_auth(anon_client):
    assert anon_client.get("/api/titles", params={"q": "a"}).status_code == 401
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_titles_endpoint.py -v`
Expected: FAIL — 404s (route doesn't exist).

- [ ] **Step 3: Implement the route**

Append to `server/src/pkm/server/routes_search.py`:

```python
@router.get("/api/titles")
def titles(q: str = "", limit: int = 10,
           db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Page-title completion for the editor's [[ / # popup."""
    limit = max(1, min(limit, 50))
    needle = q.strip()
    if not needle:
        return {"titles": []}
    esc = (needle.replace("\\", "\\\\")
                 .replace("%", "\\%")
                 .replace("_", "\\_"))
    rows = db.execute(
        r"""SELECT title FROM pages
             WHERE title LIKE ? ESCAPE '\'
             ORDER BY (CASE WHEN title LIKE ? ESCAPE '\' THEN 0 ELSE 1 END),
                      length(title), title
             LIMIT ?""",
        (f"%{esc}%", f"{esc}%", limit)).fetchall()
    return {"titles": [r["title"] for r in rows]}
```

(`LIKE` is case-insensitive for ASCII in SQLite — matches Roam's completion feel. Non-ASCII titles match case-sensitively; acceptable.)

- [ ] **Step 4: Run the endpoint tests, then the drift guard**

Run: `cd server && uv run pytest tests/test_titles_endpoint.py tests/test_openapi_sync.py -v`
Expected: titles tests PASS; `test_committed_openapi_matches_live_schema` now FAILS (new path not in the committed dump) — that's the guard working.

- [ ] **Step 5: Regenerate the committed schema files**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

Run: `cd server && uv run pytest -q`
Expected: all pass.

- [ ] **Step 6: Add the TS payload type**

Append to `web/src/api/payloads.ts`:

```ts
export interface TitlesPayload {
  titles: string[];
}
```

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/server/routes_search.py server/tests/test_titles_endpoint.py \
  web/src/api/openapi.json web/src/api/types.d.ts web/src/api/payloads.ts
git commit -m "feat: GET /api/titles page-title autocomplete endpoint"
git push
```

---

### Task 3: Plan-4 carry-forward batch — ErrorBoundary, safe hrefs, 404 route, backlink merge, a11y

Five small recorded carry-forwards, all read-side, done before editing lands on top of them.

**Files:**
- Create: `web/src/components/ErrorBoundary.tsx`
- Modify: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/components/InlineSegments.tsx`, `web/src/components/groups.ts`, `web/src/components/BacklinksSection.tsx`, `web/src/components/SearchModal.tsx`, `web/src/components/TodoCheckbox.tsx`, `web/src/views/Journal.tsx`, `web/src/styles.css`
- Test: `web/src/components/ErrorBoundary.test.tsx` (new), `web/src/App.test.tsx`, `web/src/components/InlineSegments.test.tsx`, `web/src/components/sections.test.tsx`

**Interfaces:**
- Consumes: existing components/tests.
- Produces: `ErrorBoundary` (children-wrapping class component); `mergeGroups<G extends { page_id: number; items: { uid: string }[] }>(existing: G[], incoming: G[]): G[]` — now also used by `BacklinksSection`; unknown routes render a NotFound view; markdown-link hrefs restricted to `http(s):`/`mailto:`/site-relative.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/ErrorBoundary.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("kaboom");
}

test("catches render errors and shows a fallback with a reload link", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<ErrorBoundary><Bomb /></ErrorBoundary>);
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Reload" })).toHaveAttribute("href", "/");
});

test("renders children when nothing throws", () => {
  render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
  expect(screen.getByText("fine")).toBeInTheDocument();
});
```

Append to `web/src/App.test.tsx` (match its existing render helper that mounts `<App/>` in a `MemoryRouter`):

```tsx
test("unknown route renders the not-found view", () => {
  stubFetch([]);
  renderApp("/definitely/not/a/route");
  expect(screen.getByText("Page not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Daily Notes" })).toBeInTheDocument();
});
```

(If `App.test.tsx` has no path-taking helper, render `<MemoryRouter initialEntries={["/definitely/not/a/route"]}><App /></MemoryRouter>` directly, matching the file's existing style.)

Append to `web/src/components/InlineSegments.test.tsx`:

```tsx
test("javascript: links render as plain text, not anchors", () => {
  render(<Wrapped segments={tokenizeBlock("[x](javascript:alert(1))")} />);
  expect(screen.getByText("x")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});

test("relative and mailto links stay clickable", () => {
  render(<Wrapped segments={tokenizeBlock("[m](mailto:a@b.c) [r](/assets/x/y.png)")} />);
  expect(screen.getByRole("link", { name: "m" })).toHaveAttribute("href", "mailto:a@b.c");
  expect(screen.getByRole("link", { name: "r" })).toHaveAttribute("href", "/assets/x/y.png");
});
```

(`Wrapped` = whatever router/context wrapper the file already uses for segment renders; reuse it.)

Append to `web/src/components/sections.test.tsx` — backlink pagination merging:

```tsx
test("backlinks show-more merges batches from the same source page", async () => {
  const groupA = {
    page_id: 9, page_title: "Src",
    items: [{ uid: "s1", text: "one", breadcrumbs: [] }],
  };
  const groupAmore = {
    page_id: 9, page_title: "Src",
    items: [{ uid: "s2", text: "two", breadcrumbs: [] }],
  };
  const initial = { groups: [groupA], total_pages: 2, offset: 0, limit: 1 };
  stubFetch([[
    "/api/page/T?bl_offset=1",
    pagePayload("T", [], { backlinks: { groups: [groupAmore], total_pages: 2, offset: 1, limit: 1 } }),
  ]]);
  render(<MemoryRouter><BacklinksSection title="T" initial={initial} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText("two")).toBeInTheDocument();
  // one group heading, not two duplicate-keyed groups
  expect(screen.getAllByText("Src")).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd web && pnpm test -- --run`
Expected: new tests FAIL (no ErrorBoundary module; unknown route renders empty main pane; javascript: link renders an anchor; duplicate `Src` groups).

- [ ] **Step 3: Implement ErrorBoundary**

Create `web/src/components/ErrorBoundary.tsx`:

```tsx
// pattern: Functional Core
import { Component, type ReactNode } from "react";

interface State {
  failed: boolean;
  message: string;
}

/** Root render-error net (plan-4 carry-forward): editing state raises the
 * odds of a render throw; fail to a message + reload link, not a white
 * screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: String(error) };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="error-screen">
          <h1>Something went wrong</h1>
          <p className="error">{this.state.message}</p>
          <a href="/">Reload</a>
        </div>
      );
    }
    return this.props.children;
  }
}
```

In `web/src/main.tsx`, wrap App:

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
```

(with `import { ErrorBoundary } from "./components/ErrorBoundary";`)

- [ ] **Step 4: NotFound route**

In `web/src/App.tsx`, add below the existing routes:

```tsx
<Route path="*" element={<NotFound />} />
```

and in the same file:

```tsx
function NotFound() {
  return (
    <div className="not-found">
      <h1>Page not found</h1>
      <p>No app route matches this address.</p>
      <Link to="/">Go to Daily Notes</Link>
    </div>
  );
}
```

- [ ] **Step 5: href allowlist**

In `web/src/components/InlineSegments.tsx`, add:

```tsx
/** Plan-4 carry-forward: [x](javascript:…) in block text must not become a
 * clickable anchor. http(s), mailto, and site-relative (single-slash) only. */
function isSafeHref(href: string): boolean {
  if (/^(https?:|mailto:)/i.test(href)) return true;
  return href.startsWith("/") && !href.startsWith("//");
}
```

and change the `"link"` case:

```tsx
    case "link":
      if (isPdfAssetHref(seg.href)) return <PdfEmbed href={seg.href} label={seg.text} />;
      if (!isSafeHref(seg.href)) return <>{seg.text}</>;
      return <a href={seg.href} target="_blank" rel="noreferrer">{seg.text}</a>;
```

- [ ] **Step 6: Generic mergeGroups + BacklinksSection**

Replace the signature in `web/src/components/groups.ts` (body unchanged):

```ts
// pattern: Functional Core
/** Merge a later pagination batch into accumulated groups: same page_id
 * extends the existing group (deduped by uid), new pages append. Generic so
 * backlink groups (items carry breadcrumbs) merge with the same code. */
export function mergeGroups<G extends { page_id: number; items: { uid: string }[] }>(
    existing: G[], incoming: G[]): G[] {
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

In `web/src/components/BacklinksSection.tsx`: `import { mergeGroups } from "./groups";` and change the show-more append:

```tsx
      setGroups((g) => mergeGroups(g, p.backlinks.groups));
```

Note `hasMore` still compares `groups.length < initial.total_pages` — merging keeps group count correct (a merged batch that only extended an existing page keeps `hasMore` true and the next offset unchanged, which matches the server's DISTINCT-page pagination).

- [ ] **Step 7: a11y batch**

- `SearchModal.tsx`: add `aria-label="Search"` to the input.
- `TodoCheckbox.tsx`: add `aria-label={done ? "DONE" : "TODO"}` to the input.
- `Journal.tsx`: add a `loading` state mirroring `loadingRef` (`setLoading(true)` at the top of `loadMore`'s try, `setLoading(false)` in its finally) and render just above the sentinel/button:

```tsx
      <p className="journal-status" role="status" aria-live="polite">
        {loading ? "Loading more days…" : ""}
      </p>
```

Append to `web/src/styles.css`:

```css
/* --- plan 5: carry-forwards --- */
.error-screen, .not-found { padding: 32px; }
.journal-status { min-height: 1.5em; color: #8a9ba8; margin: 4px 0; }
```

- [ ] **Step 8: Run tests + typecheck**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass (including all pre-existing tests — the TodoCheckbox/SearchModal changes are attribute-only).

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "fix: plan-4 carry-forwards - error boundary, href allowlist, 404 route, backlink merge, a11y"
git push
```

### Task 4: Outline core I — op types, uid generator, tree utilities, `applyOps`

The foundation of the whole editor: TS aliases over the generated op schemas, a uid generator matching the server's `^[a-zA-Z0-9_-]{6,32}$`, tree lookup/visibility helpers, and `applyOps` — the ONE function that applies committed op semantics to a client tree, mirroring `ops_apply.py` exactly. Local optimistic edits and remote WebSocket batches both go through it.

**Files:**
- Create: `web/src/api/ops.ts`, `web/src/uid.ts`, `web/src/outline/tree.ts`
- Test: `web/src/uid.test.ts`, `web/src/outline/tree.test.ts`

**Interfaces:**
- Consumes: `components["schemas"][…]` from the generated `web/src/api/types.d.ts`; `BlockNode` (now with `order_idx`).
- Produces (used by T5–T12):
  - `api/ops.ts`: `CreateOp`, `UpdateTextOp`, `MoveOp`, `DeleteOp`, `SetCollapsedOp`, `BlockOp` (union), `OpBatch`.
  - `uid.ts`: `newUid(): string`.
  - `outline/tree.ts`: `interface Located { node; parent; siblings; index }`, `locate(blocks, uid): Located | null`, `findNode(blocks, uid): BlockNode | null`, `visibleUids(blocks): string[]`, `visibleNeighbor(blocks, uid, dir: "up" | "down"): string | null`, `applyOps(blocks, ops, pageTitle): BlockNode[]`.

- [ ] **Step 1: op type aliases (type-only, no test)**

Create `web/src/api/ops.ts`:

```ts
// Type-only aliases over the generated OpenAPI schema (src/api/types.d.ts):
// the server's Pydantic op models are the single source of truth for what
// the editor is allowed to send.
import type { components } from "./types";

export type CreateOp = components["schemas"]["CreateOp"];
export type UpdateTextOp = components["schemas"]["UpdateTextOp"];
export type MoveOp = components["schemas"]["MoveOp"];
export type DeleteOp = components["schemas"]["DeleteOp"];
export type SetCollapsedOp = components["schemas"]["SetCollapsedOp"];

export type BlockOp =
  | CreateOp | UpdateTextOp | MoveOp | DeleteOp | SetCollapsedOp;

export type OpBatch = components["schemas"]["OpBatch"];
```

Run: `cd web && pnpm typecheck` — expected clean (proves the schema names resolve).

- [ ] **Step 2: failing uid test**

Create `web/src/uid.test.ts`:

```ts
import { expect, test } from "vitest";
import { newUid } from "./uid";

test("uids match the server's UID_RE and don't collide", () => {
  const uids = Array.from({ length: 200 }, () => newUid());
  for (const uid of uids) expect(uid).toMatch(/^[a-zA-Z0-9_-]{6,32}$/);
  expect(new Set(uids).size).toBe(200);
});
```

Run: `cd web && pnpm test -- --run src/uid.test.ts` → FAIL (module missing).

- [ ] **Step 3: implement newUid**

Create `web/src/uid.ts`:

```ts
// pattern: Functional Core
// 16 chars from a 64-symbol alphabet (uniform: 64 divides 256) via
// crypto.getRandomValues — matches the server's ^[a-zA-Z0-9_-]{6,32}$ and
// the spec's "new = nanoid" without a dependency. ~96 bits of entropy.
const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}
```

Run: `cd web && pnpm test -- --run src/uid.test.ts` → PASS.

- [ ] **Step 4: failing tree utility + applyOps tests**

Create `web/src/outline/tree.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { block } from "../test-helpers";
import { applyOps, findNode, locate, visibleNeighbor, visibleUids } from "./tree";

// Siblings with order_idx GAPS (0, 5, 7) — the server leaves gaps after
// shifts; every helper must key on order_idx values, never array positions.
const tree = () => [
  block("a", "A", { order_idx: 0 }),
  block("b", "B", {
    order_idx: 5,
    children: [
      block("b1", "B1", { order_idx: 0 }),
      block("b2", "B2", { order_idx: 3 }),
    ],
  }),
  block("c", "C", { order_idx: 7, collapsed: true,
                    children: [block("c1", "C1", { order_idx: 0 })] }),
];

describe("locate / visibility", () => {
  test("locate finds nested nodes with parent and index", () => {
    const found = locate(tree(), "b2")!;
    expect(found.node.uid).toBe("b2");
    expect(found.parent?.uid).toBe("b");
    expect(found.index).toBe(1);
    expect(found.siblings.map((s) => s.uid)).toEqual(["b1", "b2"]);
    expect(locate(tree(), "nope")).toBeNull();
  });

  test("visibleUids skips children of collapsed blocks", () => {
    expect(visibleUids(tree())).toEqual(["a", "b", "b1", "b2", "c"]);
  });

  test("visibleNeighbor walks the on-screen order", () => {
    expect(visibleNeighbor(tree(), "b2", "down")).toBe("c");
    expect(visibleNeighbor(tree(), "b", "up")).toBe("a");
    expect(visibleNeighbor(tree(), "a", "up")).toBeNull();
    expect(visibleNeighbor(tree(), "c", "down")).toBeNull();
  });
});

describe("applyOps mirrors ops_apply.py", () => {
  test("create shifts later siblings and inserts sorted", () => {
    const op: BlockOp = { op: "create", uid: "n1", page_title: "P",
                          parent_uid: null, order_idx: 5, text: "new" };
    const out = applyOps(tree(), [op], "P");
    expect(out.map((n) => [n.uid, n.order_idx])).toEqual(
      [["a", 0], ["n1", 5], ["b", 6], ["c", 8]]);
  });

  test("create for another page is skipped", () => {
    const op: BlockOp = { op: "create", uid: "n1", page_title: "Other",
                          parent_uid: null, order_idx: 0, text: "x" };
    expect(applyOps(tree(), [op], "P").map((n) => n.uid)).toEqual(["a", "b", "c"]);
  });

  test("move follows insert-before-pre-removal semantics ([A,B,C] A->2 = [B,A,C])", () => {
    const abc = [block("a", "A", { order_idx: 0 }),
                 block("b", "B", { order_idx: 1 }),
                 block("c", "C", { order_idx: 2 })];
    const op: BlockOp = { op: "move", uid: "a", parent_uid: null, order_idx: 2 };
    const out = applyOps(abc, [op], "P");
    expect(out.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(out.map((n) => n.order_idx)).toEqual([1, 2, 3]);
  });

  test("move reparents into a nested target", () => {
    const op: BlockOp = { op: "move", uid: "a", parent_uid: "b", order_idx: 3 };
    const out = applyOps(tree(), [op], "P");
    expect(out.map((n) => n.uid)).toEqual(["b", "c"]);
    expect(findNode(out, "b")!.children.map((n) => [n.uid, n.order_idx]))
      .toEqual([["b1", 0], ["a", 3], ["b2", 4]]);
  });

  test("delete removes the whole subtree; update_text and set_collapsed hit the node", () => {
    const out = applyOps(tree(), [
      { op: "delete", uid: "b" },
      { op: "update_text", uid: "a", text: "A!" },
      { op: "set_collapsed", uid: "c", collapsed: false },
    ], "P");
    expect(out.map((n) => n.uid)).toEqual(["a", "c"]);
    expect(findNode(out, "a")!.text).toBe("A!");
    expect(findNode(out, "c")!.collapsed).toBe(false);
    expect(findNode(out, "b1")).toBeNull();
  });

  test("ops for uids not in this tree (other pages on the ws) are skipped", () => {
    const out = applyOps(tree(), [
      { op: "update_text", uid: "zz", text: "x" },
      { op: "delete", uid: "zz" },
      { op: "move", uid: "zz", parent_uid: null, order_idx: 0 },
      { op: "set_collapsed", uid: "zz", collapsed: true },
    ], "P");
    expect(out.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  });

  test("does not mutate its input", () => {
    const input = tree();
    applyOps(input, [{ op: "update_text", uid: "a", text: "changed" }], "P");
    expect(input[0].text).toBe("A");
  });
});
```

Run: `cd web && pnpm test -- --run src/outline/tree.test.ts` → FAIL (module missing).

- [ ] **Step 5: implement outline/tree.ts**

Create `web/src/outline/tree.ts`:

```ts
// pattern: Functional Core
// Pure helpers over the page block tree: lookup, on-screen order, and
// applying committed op semantics so local state mirrors the server's
// ops_apply.py exactly. ShiftSiblings leaves order_idx gaps on the server;
// everything here keys on order_idx VALUES, never array positions.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";

export interface Located {
  node: BlockNode;
  parent: BlockNode | null; // null = top-level
  siblings: BlockNode[];    // the array that contains node
  index: number;            // node's position within siblings
}

export function locate(blocks: BlockNode[], uid: string): Located | null {
  const walk = (siblings: BlockNode[], parent: BlockNode | null): Located | null => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      if (node.uid === uid) return { node, parent, siblings, index: i };
      const found = walk(node.children, node);
      if (found) return found;
    }
    return null;
  };
  return walk(blocks, null);
}

export function findNode(blocks: BlockNode[], uid: string): BlockNode | null {
  return locate(blocks, uid)?.node ?? null;
}

/** Depth-first uids in on-screen order; children of collapsed blocks hidden. */
export function visibleUids(blocks: BlockNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: BlockNode[]) => {
    for (const n of nodes) {
      out.push(n.uid);
      if (!n.collapsed) walk(n.children);
    }
  };
  walk(blocks);
  return out;
}

export function visibleNeighbor(blocks: BlockNode[], uid: string,
                                dir: "up" | "down"): string | null {
  const order = visibleUids(blocks);
  const i = order.indexOf(uid);
  if (i < 0) return null;
  return order[dir === "up" ? i - 1 : i + 1] ?? null;
}

function clone(nodes: BlockNode[]): BlockNode[] {
  return nodes.map((n) => ({ ...n, children: clone(n.children) }));
}

function sortSiblings(siblings: BlockNode[]): void {
  siblings.sort((a, b) => a.order_idx - b.order_idx);
}

function siblingsOf(tree: BlockNode[], parentUid: string | null): BlockNode[] | null {
  if (parentUid === null) return tree;
  return locate(tree, parentUid)?.node.children ?? null;
}

/** Mirror of the server's ShiftSiblings effect: everything at or past
 * from_idx moves up one — except the block being moved, whose order_idx is
 * about to be overwritten (matching SetParent-after-ShiftSiblings). */
function shiftFrom(siblings: BlockNode[], fromIdx: number, except?: string): void {
  for (const s of siblings) {
    if (s.uid !== except && s.order_idx >= fromIdx) s.order_idx += 1;
  }
}

/** Apply committed ops to a client tree — the single source of truth for op
 * semantics on the client; both optimistic local edits and remote websocket
 * batches go through here. Ops that don't concern this page are skipped:
 * create is filtered by page_title, everything else by uid presence (the
 * websocket broadcasts ops for ALL pages). Returns a new tree. */
export function applyOps(blocks: BlockNode[], ops: BlockOp[],
                         pageTitle: string): BlockNode[] {
  const tree = clone(blocks);
  for (const op of ops) applyOne(tree, op, pageTitle);
  return tree;
}

function applyOne(tree: BlockNode[], op: BlockOp, pageTitle: string): void {
  if (op.op === "create") {
    if (op.page_title !== pageTitle) return;
    if (locate(tree, op.uid)) return; // replay of a block we already have
    const siblings = siblingsOf(tree, op.parent_uid ?? null);
    if (siblings === null) return;    // parent unknown here: skip
    shiftFrom(siblings, op.order_idx);
    siblings.push({
      uid: op.uid, text: op.text, heading: op.heading ?? null,
      collapsed: false, order_idx: op.order_idx,
      created_at: null, updated_at: null, children: [],
    });
    sortSiblings(siblings);
    return;
  }
  const found = locate(tree, op.uid);
  if (!found) return; // op for another page: skip
  if (op.op === "update_text") {
    found.node.text = op.text;
  } else if (op.op === "set_collapsed") {
    found.node.collapsed = op.collapsed;
  } else if (op.op === "delete") {
    found.siblings.splice(found.index, 1);
  } else { // move — order_idx counted BEFORE the moved block is removed
    const target = siblingsOf(tree, op.parent_uid);
    if (target === null) return;
    shiftFrom(target, op.order_idx, op.uid);
    found.siblings.splice(found.index, 1);
    found.node.order_idx = op.order_idx;
    target.push(found.node);
    sortSiblings(target);
  }
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/api/ops.ts web/src/uid.ts web/src/uid.test.ts \
  web/src/outline/tree.ts web/src/outline/tree.test.ts
git commit -m "feat: outline core - op types, uid generator, tree utilities, applyOps"
git push
```

---

### Task 5: Outline core II — edit commands (split/indent/outdent/move/backspace/todo/collapse)

Each user gesture becomes `{ blocks, ops, focus }`: the exact op batch the server will receive, the tree after applying it (via T4's `applyOps` — the ops ARE the local mutation), and where focus lands. All pure; `newUid` is injected.

**Files:**
- Create: `web/src/outline/edits.ts`, `web/src/grammar/todo.ts`
- Test: `web/src/outline/edits.test.ts`, `web/src/grammar/todo.test.ts`

**Interfaces:**
- Consumes: T4's `applyOps`, `locate`, `findNode`; `BlockOp`.
- Produces (used by T10's `useOutline`):
  - `interface FocusTarget { uid: string; cursor: number }`
  - `interface EditResult { blocks: BlockNode[]; ops: BlockOp[]; focus: FocusTarget | null }` (`ops: []` = gesture was a no-op; `focus: null` = leave focus alone)
  - `splitBlock(blocks, pageTitle, uid, cursor, newUid)`, `indentBlock(blocks, pageTitle, uid)`, `outdentBlock(blocks, pageTitle, uid)`, `moveBlockUp(...)`, `moveBlockDown(...)`, `backspaceAtStart(...)`, `setCollapsed(blocks, pageTitle, uid, collapsed)` — all `(…) => EditResult`
  - `grammar/todo.ts`: `toggleTodo(text: string): string | null` (null = no marker)

- [ ] **Step 1: failing toggleTodo tests**

Create `web/src/grammar/todo.test.ts`:

```ts
import { expect, test } from "vitest";
import { toggleTodo } from "./todo";

test("flips TODO to DONE and back, preserving the bracket variant", () => {
  expect(toggleTodo("{{[[TODO]]}} buy milk")).toBe("{{[[DONE]]}} buy milk");
  expect(toggleTodo("{{[[DONE]]}} buy milk")).toBe("{{[[TODO]]}} buy milk");
  expect(toggleTodo("{{TODO}} short form")).toBe("{{DONE}} short form");
});

test("mixed-bracket leniencies are echoed back as-is", () => {
  // The tokenizer accepts these independently (documented plan-4 leniency);
  // Roam never emits them, but a toggle must not corrupt them.
  expect(toggleTodo("{{[[TODO}} x")).toBe("{{[[DONE}} x");
  expect(toggleTodo("{{TODO]]}} x")).toBe("{{DONE]]}} x");
});

test("returns null when the block has no leading marker", () => {
  expect(toggleTodo("no marker {{[[TODO]]}} not at start")).toBeNull();
  expect(toggleTodo("plain")).toBeNull();
});
```

Run: `cd web && pnpm test -- --run src/grammar/todo.test.ts` → FAIL.

- [ ] **Step 2: implement toggleTodo**

Create `web/src/grammar/todo.ts`:

```ts
// pattern: Functional Core
// Flip the block-start {{TODO}}/{{DONE}} marker, echoing back whichever
// bracket variant the text used. Mirrors tokenize.ts TODO_PREFIX, which
// (documented leniency) accepts each bracket side independently; Roam only
// emits {{[[TODO]]}} / {{TODO}}, but toggling must never corrupt text.
const TODO_RE = /^\{\{(\[\[)?(TODO|DONE)(\]\])?\}\}/;

export function toggleTodo(text: string): string | null {
  const m = TODO_RE.exec(text);
  if (!m) return null;
  const flipped = m[2] === "TODO" ? "DONE" : "TODO";
  return `{{${m[1] ?? ""}${flipped}${m[3] ?? ""}}}` + text.slice(m[0].length);
}
```

Run: `cd web && pnpm test -- --run src/grammar/todo.test.ts` → PASS.

- [ ] **Step 3: failing edit-command tests**

Create `web/src/outline/edits.test.ts`. The fixture reuses gap-y order_idx values so every op is asserted in the server's frame of reference:

```ts
import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { findNode } from "./tree";
import { backspaceAtStart, indentBlock, moveBlockDown, moveBlockUp,
         outdentBlock, setCollapsed, splitBlock } from "./edits";

const P = "Page";
const tree = () => [
  block("a", "alpha", { order_idx: 0 }),
  block("b", "beta", {
    order_idx: 5,
    children: [
      block("b1", "b-one", { order_idx: 0 }),
      block("b2", "b-two", { order_idx: 3 }),
    ],
  }),
  block("c", "gamma", { order_idx: 7 }),
];

describe("splitBlock", () => {
  test("mid-text: keeps head in place, tail becomes the next sibling, focus on new", () => {
    const r = splitBlock(tree(), P, "a", 2, "new111");
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "al" },
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 5, text: "pha" }, // before b (order 5), server shifts b,c
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "new111", "b", "c"]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at end of a childless block: plain empty sibling, no update_text", () => {
    const r = splitBlock(tree(), P, "c", 5, "new111");
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 8, text: "" },
    ]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at cursor 0 with text: empty block inserted ABOVE, uid keeps its text", () => {
    const r = splitBlock(tree(), P, "a", 0, "new111");
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 0, text: "" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["new111", "a", "b", "c"]);
    expect(r.focus).toEqual({ uid: "a", cursor: 0 });
  });

  test("on an expanded block with children: new block becomes first child", () => {
    const r = splitBlock(tree(), P, "b", 4, "new111");
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: "b",
        order_idx: 0, text: "" },
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["new111", "b1", "b2"]);
  });

  test("unknown uid is a no-op", () => {
    const r = splitBlock(tree(), P, "zz", 0, "new111");
    expect(r.ops).toEqual([]);
  });
});

describe("indent / outdent", () => {
  test("indent moves under previous sibling, after its last child", () => {
    const r = indentBlock(tree(), P, "c");
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: "b", order_idx: 4 }, // b2 is 3
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2", "c"]);
  });

  test("indent expands a collapsed new parent first", () => {
    const t = tree();
    findNode(t, "b")!.collapsed = true;
    const r = indentBlock(t, P, "c");
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "b", collapsed: false },
      { op: "move", uid: "c", parent_uid: "b", order_idx: 4 },
    ]);
  });

  test("first sibling can't indent", () => {
    expect(indentBlock(tree(), P, "a").ops).toEqual([]);
    expect(indentBlock(tree(), P, "b1").ops).toEqual([]);
  });

  test("outdent becomes the sibling right after its old parent", () => {
    const r = outdentBlock(tree(), P, "b1");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: null, order_idx: 7 }, // before c
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "b1", "c"]);
  });

  test("top-level blocks can't outdent", () => {
    expect(outdentBlock(tree(), P, "a").ops).toEqual([]);
  });
});

describe("moveBlockUp / moveBlockDown", () => {
  test("up swaps with previous sibling (insert before it)", () => {
    const r = moveBlockUp(tree(), P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
  });

  test("down inserts before the block after next ([a,b,c]: a -> before c)", () => {
    const r = moveBlockDown(tree(), P, "a");
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
  });

  test("down from the second-to-last lands last", () => {
    const r = moveBlockDown(tree(), P, "b");
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "c", "b"]);
  });

  test("edges are no-ops", () => {
    expect(moveBlockUp(tree(), P, "a").ops).toEqual([]);
    expect(moveBlockDown(tree(), P, "c").ops).toEqual([]);
  });
});

describe("backspaceAtStart", () => {
  test("merges a childless block into its childless previous sibling", () => {
    const t = [block("x", "one", { order_idx: 0 }),
               block("y", "two", { order_idx: 1 })];
    const r = backspaceAtStart(t, P, "y");
    expect(r.ops).toEqual([
      { op: "update_text", uid: "x", text: "onetwo" },
      { op: "delete", uid: "y" },
    ]);
    expect(r.focus).toEqual({ uid: "x", cursor: 3 });
  });

  test("empty block after a structured sibling: deleted, focus on last visible descendant", () => {
    const base = tree();
    // d sits between b (has children) and c
    const t = [base[0], base[1], block("d", "", { order_idx: 6 }), base[2]];
    const r = backspaceAtStart(t, P, "d");
    expect(r.ops).toEqual([{ op: "delete", uid: "d" }]);
    expect(r.focus).toEqual({ uid: "b2", cursor: 5 }); // "b-two".length
  });

  test("no-ops: first sibling, block with children, non-empty after structured prev", () => {
    expect(backspaceAtStart(tree(), P, "a").ops).toEqual([]);
    expect(backspaceAtStart(tree(), P, "b1").ops).toEqual([]); // first child
    expect(backspaceAtStart(tree(), P, "b").ops).toEqual([]);  // has children
    const t = [tree()[1], block("d", "text", { order_idx: 6 })];
    expect(backspaceAtStart(t, P, "d").ops).toEqual([]); // prev structured, not empty
  });
});

describe("setCollapsed", () => {
  test("emits the op and applies it", () => {
    const r = setCollapsed(tree(), P, "b", true);
    expect(r.ops).toEqual([{ op: "set_collapsed", uid: "b", collapsed: true }]);
    expect(findNode(r.blocks, "b")!.collapsed).toBe(true);
  });
});
```

Run: `cd web && pnpm test -- --run src/outline/edits.test.ts` → FAIL.

- [ ] **Step 4: implement edits.ts**

Create `web/src/outline/edits.ts`:

```ts
// pattern: Functional Core
// Outline edit commands: each gesture becomes the exact server op batch, the
// tree after applying it (via applyOps — the ops ARE the local mutation, so
// optimistic state can't diverge from what the server will do), and where
// focus lands. MoveOp.order_idx is "insert before the block currently at
// order_idx, counted BEFORE the moved block is removed" (plan-3 contract
// note) — order_idx values are always read off the tree, never array
// positions, because the server leaves gaps.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { applyOps, findNode, locate } from "./tree";

export interface FocusTarget {
  uid: string;
  cursor: number;
}

export interface EditResult {
  blocks: BlockNode[];
  ops: BlockOp[];
  focus: FocusTarget | null; // null = leave focus where it is
}

function noop(blocks: BlockNode[]): EditResult {
  return { blocks, ops: [], focus: null };
}

function done(blocks: BlockNode[], pageTitle: string, ops: BlockOp[],
              focus: FocusTarget | null): EditResult {
  return { blocks: applyOps(blocks, ops, pageTitle), ops, focus };
}

/** order_idx that inserts immediately after siblings[index]: the next
 * sibling's order_idx (insert before it), or last + 1. */
function idxAfter(siblings: BlockNode[], index: number): number {
  const next = siblings[index + 1];
  return next ? next.order_idx : siblings[index].order_idx + 1;
}

export function splitBlock(blocks: BlockNode[], pageTitle: string, uid: string,
                           cursor: number, newUid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found) return noop(blocks);
  const { node, parent, siblings, index } = found;
  if (cursor === 0 && node.text !== "") {
    // Enter at the start: push the block down by inserting an empty sibling
    // ABOVE — the existing uid keeps its text (and any ((uid)) refs to it).
    const ops: BlockOp[] = [{ op: "create", uid: newUid, page_title: pageTitle,
                              parent_uid: parent?.uid ?? null,
                              order_idx: node.order_idx, text: "" }];
    return done(blocks, pageTitle, ops, { uid, cursor: 0 });
  }
  const before = node.text.slice(0, cursor);
  const after = node.text.slice(cursor);
  const ops: BlockOp[] = [];
  if (after !== "") ops.push({ op: "update_text", uid, text: before });
  const intoChildren = node.children.length > 0 && !node.collapsed;
  ops.push({
    op: "create", uid: newUid, page_title: pageTitle,
    parent_uid: intoChildren ? uid : parent?.uid ?? null,
    order_idx: intoChildren ? node.children[0].order_idx
                            : idxAfter(siblings, index),
    text: after,
  });
  return done(blocks, pageTitle, ops, { uid: newUid, cursor: 0 });
}

export function indentBlock(blocks: BlockNode[], pageTitle: string,
                            uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.index === 0) return noop(blocks);
  const prev = found.siblings[found.index - 1];
  const last = prev.children[prev.children.length - 1];
  const ops: BlockOp[] = [];
  if (prev.collapsed) {
    ops.push({ op: "set_collapsed", uid: prev.uid, collapsed: false });
  }
  ops.push({ op: "move", uid, parent_uid: prev.uid,
             order_idx: last ? last.order_idx + 1 : 0 });
  return done(blocks, pageTitle, ops, null);
}

export function outdentBlock(blocks: BlockNode[], pageTitle: string,
                             uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.parent === null) return noop(blocks);
  const parentLoc = locate(blocks, found.parent.uid);
  if (!parentLoc) return noop(blocks);
  const ops: BlockOp[] = [{
    op: "move", uid, parent_uid: parentLoc.parent?.uid ?? null,
    order_idx: idxAfter(parentLoc.siblings, parentLoc.index),
  }];
  return done(blocks, pageTitle, ops, null);
}

export function moveBlockUp(blocks: BlockNode[], pageTitle: string,
                            uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.index === 0) return noop(blocks);
  const prev = found.siblings[found.index - 1];
  const ops: BlockOp[] = [{ op: "move", uid,
                            parent_uid: found.parent?.uid ?? null,
                            order_idx: prev.order_idx }];
  return done(blocks, pageTitle, ops, null);
}

export function moveBlockDown(blocks: BlockNode[], pageTitle: string,
                              uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.index === found.siblings.length - 1) return noop(blocks);
  const ops: BlockOp[] = [{ op: "move", uid,
                            parent_uid: found.parent?.uid ?? null,
                            order_idx: idxAfter(found.siblings, found.index + 1) }];
  return done(blocks, pageTitle, ops, null);
}

export function backspaceAtStart(blocks: BlockNode[], pageTitle: string,
                                 uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.node.children.length > 0 || found.index === 0) {
    return noop(blocks);
  }
  const prev = found.siblings[found.index - 1];
  if (prev.children.length > 0) {
    // Merging into a structured block is ambiguous; only delete-if-empty,
    // landing focus on the block that visually precedes the deleted one.
    if (found.node.text !== "") return noop(blocks);
    let target = prev;
    while (!target.collapsed && target.children.length > 0) {
      target = target.children[target.children.length - 1];
    }
    return done(blocks, pageTitle, [{ op: "delete", uid }],
                { uid: target.uid, cursor: target.text.length });
  }
  const ops: BlockOp[] = [
    { op: "update_text", uid: prev.uid, text: prev.text + found.node.text },
    { op: "delete", uid },
  ];
  return done(blocks, pageTitle, ops,
              { uid: prev.uid, cursor: prev.text.length });
}

export function setCollapsed(blocks: BlockNode[], pageTitle: string,
                             uid: string, collapsed: boolean): EditResult {
  if (!findNode(blocks, uid)) return noop(blocks);
  return done(blocks, pageTitle,
              [{ op: "set_collapsed", uid, collapsed }], null);
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/outline/edits.ts web/src/outline/edits.test.ts \
  web/src/grammar/todo.ts web/src/grammar/todo.test.ts
git commit -m "feat: outline edit commands - split, indent, outdent, move, backspace-merge, todo toggle"
git push
```

### Task 6: Op queue — `clientId`, coalescing batches, desync on failure

The serializing shell between the outline and `POST /api/ops`: ops enqueued in the same tick coalesce into one batch, only one request is ever in flight, and a failed batch clears the queue and reports desync so the caller refetches (server is authoritative; per the spec there is no retry/merge story).

**Files:**
- Create: `web/src/sync/opQueue.ts`
- Test: `web/src/sync/opQueue.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `newUid`, `BlockOp`.
- Produces (used by T7's provider): `clientId: string` (module-level, per-tab); `createOpQueue(onDesync: (e: unknown) => void): OpQueue` with `enqueue(ops: BlockOp[]): void` and `idle(): Promise<void>` (test/synchronization helper: resolves when nothing is pending or in flight).

- [ ] **Step 1: failing tests**

Create `web/src/sync/opQueue.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import { jsonResponse } from "../test-helpers";
import { clientId, createOpQueue } from "./opQueue";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

function capturingFetch(responses: Array<() => Response>) {
  const bodies: unknown[] = [];
  let call = 0;
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return make();
  });
  vi.stubGlobal("fetch", mock);
  return { bodies, mock };
}

test("clientId is stable and uid-shaped", () => {
  expect(clientId).toMatch(/^[a-zA-Z0-9_-]{6,32}$/);
});

test("ops enqueued in the same tick coalesce into one batch", async () => {
  const { bodies, mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(() => undefined);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2"), op("u3")]);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(bodies[0]).toEqual({
    client_id: clientId,
    ops: [op("u1"), op("u2"), op("u3")],
  });
});

test("ops enqueued while a batch is in flight go in the next batch", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const bodies: unknown[] = [];
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) await gate;
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  const q = createOpQueue(() => undefined);
  q.enqueue([op("u1")]);
  await Promise.resolve(); // let the first batch dispatch
  q.enqueue([op("u2")]);
  release();
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u2")]);
});

test("a failed batch clears the queue and reports desync; queue keeps working", async () => {
  const { mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const onDesync = vi.fn();
  const q = createOpQueue(onDesync);
  q.enqueue([op("u1"), op("u2")]);
  await q.idle();
  expect(onDesync).toHaveBeenCalledTimes(1);
  // queue survives: a later enqueue sends normally
  q.enqueue([op("u3")]);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
});
```

Run: `cd web && pnpm test -- --run src/sync/opQueue.test.ts` → FAIL (module missing).

- [ ] **Step 2: implement opQueue**

Create `web/src/sync/opQueue.ts`:

```ts
// pattern: Imperative Shell
// Serializes op batches to POST /api/ops: ops enqueued in the same tick
// coalesce into one batch, only one request is in flight at a time, and a
// failed batch clears the queue and reports desync — the caller refetches
// authoritative state (spec: server-authoritative, no offline merge).
import { apiFetch } from "../api/client";
import type { BlockOp } from "../api/ops";
import { newUid } from "../uid";

/** Stable per-tab id: the server echoes it on the websocket so this tab can
 * skip its own (already optimistically applied) batches. */
export const clientId = newUid();

const MAX_BATCH = 500; // OpBatch.ops max_length on the server

export interface OpQueue {
  enqueue(ops: BlockOp[]): void;
  /** Resolves once nothing is pending or in flight (tests, smoke). */
  idle(): Promise<void>;
}

export function createOpQueue(onDesync: (e: unknown) => void): OpQueue {
  let pending: BlockOp[] = [];
  let inflight: Promise<void> | null = null;

  const pump = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending.slice(0, MAX_BATCH);
      pending = pending.slice(batch.length);
      try {
        await apiFetch("/api/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId, ops: batch }),
        });
      } catch (e: unknown) {
        pending = [];
        onDesync(e);
        return;
      }
    }
  };

  const kick = () => {
    if (inflight) return; // the running pump loop will pick pending up
    // microtask delay so every op from one keystroke joins one batch
    inflight = Promise.resolve().then(async () => {
      try {
        await pump();
      } finally {
        inflight = null;
      }
    });
  };

  return {
    enqueue(ops: BlockOp[]) {
      if (ops.length === 0) return;
      pending.push(...ops);
      kick();
    },
    async idle() {
      while (inflight) await inflight;
    },
  };
}
```

- [ ] **Step 3: Run tests + typecheck**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/sync/opQueue.ts web/src/sync/opQueue.test.ts
git commit -m "feat: serializing op queue with per-tab client id and desync reporting"
git push
```

---

### Task 7: WebSocket client, `SyncProvider`, reconnect banner

The live-sync shell: a reconnecting `/api/ws` client, a React context tying socket + op queue together (`status`, `enqueue`, `subscribe`, `resyncSeq`), the "Reconnecting…" banner, and dev-proxy websocket support. Spec behaviour: dropped connection ⇒ banner + writes paused; on reconnect (and on any rejected batch) `resyncSeq` bumps and views refetch.

**Files:**
- Create: `web/src/sync/socket.ts`, `web/src/sync/SyncProvider.tsx`, `web/src/components/ReconnectBanner.tsx`
- Modify: `web/src/App.tsx`, `web/src/test-helpers.ts`, `web/src/test-setup.ts`, `web/vite.config.ts`, `web/src/styles.css`
- Test: `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: T6's `clientId`/`createOpQueue`; browser `WebSocket`.
- Produces (used by T8/T10/T12):
  - `socket.ts`: `interface WsBatch { client_id: string; ts: number; ops: BlockOp[] }`, `connectSocket({ onBatch, onStatus }): { close(): void }`.
  - `SyncProvider.tsx`: `type SyncStatus = "connecting" | "connected" | "reconnecting"`, `interface Sync { status: SyncStatus; resyncSeq: number; enqueue(ops: BlockOp[]): void; subscribe(fn: (b: WsBatch) => void): () => void }`, `SyncContext`, `useSync(): Sync`, `useResync(fn: () => void): void`, `SyncProvider` component.
  - `test-helpers.ts`: `FakeWebSocket` (instance-tracking stub with `open()`, `message(body)`, `close()` drivers).

- [ ] **Step 1: FakeWebSocket + global stub**

Append to `web/src/test-helpers.ts`:

```ts
/** WebSocket stub installed globally in test-setup: quiet by default (never
 * opens); tests drive instances via FakeWebSocket.instances. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closedByApp = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }

  close() { this.closedByApp = true; this.onclose?.(); }

  // --- test drivers ---
  open() { this.onopen?.(); }
  message(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
  drop() { this.onclose?.(); }
}
```

Append to `web/src/test-setup.ts`:

```ts
import { afterEach, vi } from "vitest";
import { FakeWebSocket } from "./test-helpers";

vi.stubGlobal("WebSocket", FakeWebSocket);
afterEach(() => { FakeWebSocket.instances = []; });
```

(If `test-setup.ts` already has imports/afterEach blocks, merge rather than duplicate.)

- [ ] **Step 2: failing SyncProvider tests**

Create `web/src/sync/SyncProvider.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { FakeWebSocket, stubFetch } from "../test-helpers";
import type { WsBatch } from "./socket";
import { clientId } from "./opQueue";
import { SyncProvider, useSync } from "./SyncProvider";

function Probe({ onBatch }: { onBatch: (b: WsBatch) => void }) {
  const sync = useSync();
  useEffect(() => sync.subscribe(onBatch), [sync, onBatch]);
  return <div data-testid="status">{sync.status}:{sync.resyncSeq}</div>;
}

beforeEach(() => {
  stubFetch([["/api/ops", { ok: true }]]);
});

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

test("status: connecting -> connected -> reconnecting -> connected, resync bump on re-open", () => {
  vi.useFakeTimers();
  const onBatch = vi.fn();
  render(<SyncProvider><Probe onBatch={onBatch} /></SyncProvider>);
  expect(screen.getByTestId("status").textContent).toBe("connecting:0");
  act(() => lastWs().open());
  expect(screen.getByTestId("status").textContent).toBe("connected:0");
  act(() => lastWs().drop());
  expect(screen.getByTestId("status").textContent).toBe("reconnecting:0");
  act(() => { vi.advanceTimersByTime(2000); }); // reconnect timer -> new socket
  act(() => lastWs().open());
  // re-established after a gap: views must refetch (resyncSeq bumped)
  expect(screen.getByTestId("status").textContent).toBe("connected:1");
  vi.useRealTimers();
});

test("dispatches remote batches to subscribers, filters own echoes", () => {
  const onBatch = vi.fn();
  render(<SyncProvider><Probe onBatch={onBatch} /></SyncProvider>);
  act(() => lastWs().open());
  const remote = { client_id: "someone-else", ts: 1,
                   ops: [{ op: "delete", uid: "u1" }] };
  act(() => lastWs().message(remote));
  act(() => lastWs().message({ client_id: clientId, ts: 2, ops: [] }));
  expect(onBatch).toHaveBeenCalledTimes(1);
  expect(onBatch).toHaveBeenCalledWith(remote);
});

test("connects to /api/ws on the current host", () => {
  render(<SyncProvider><div /></SyncProvider>);
  expect(lastWs().url).toMatch(/^ws{1,2}:\/\/.+\/api\/ws$/);
});
```

Run: `cd web && pnpm test -- --run src/sync/SyncProvider.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: implement socket.ts**

Create `web/src/sync/socket.ts`:

```ts
// pattern: Imperative Shell
// /api/ws client: JSON batch dispatch, keepalive pings (the server ignores
// inbound frames), and auto-reconnect on a fixed 2s timer until close().
import type { BlockOp } from "../api/ops";

export interface WsBatch {
  client_id: string;
  ts: number;
  ops: BlockOp[];
}

export interface SocketHandle {
  close(): void;
}

const RECONNECT_MS = 2000;
const PING_MS = 30_000;

export function connectSocket(opts: {
  onBatch: (batch: WsBatch) => void;
  onStatus: (connected: boolean) => void;
}): SocketHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/api/ws`);
    ws.onopen = () => {
      opts.onStatus(true);
      pingTimer = setInterval(() => ws?.send("ping"), PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      opts.onBatch(JSON.parse(String(ev.data)) as WsBatch);
    };
    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      opts.onStatus(false);
      if (!closed) reconnectTimer = setTimeout(open, RECONNECT_MS);
    };
  };
  open();

  return {
    close() {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
```

- [ ] **Step 4: implement SyncProvider.tsx**

Create `web/src/sync/SyncProvider.tsx`:

```tsx
// pattern: Imperative Shell
// Ties the websocket and the op queue into one context. status drives the
// banner and read-only editing (spec: writes paused while disconnected —
// divergence impossible rather than merged). resyncSeq bumps whenever local
// state may have diverged (rejected batch, or reconnect after a gap):
// views refetch authoritative state via useResync.
import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type ReactNode } from "react";
import type { BlockOp } from "../api/ops";
import { clientId, createOpQueue } from "./opQueue";
import { connectSocket, type WsBatch } from "./socket";

export type SyncStatus = "connecting" | "connected" | "reconnecting";

export interface Sync {
  status: SyncStatus;
  resyncSeq: number;
  enqueue(ops: BlockOp[]): void;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
}

export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
  enqueue: () => undefined,
  subscribe: () => () => undefined,
});

export function useSync(): Sync {
  return useContext(SyncContext);
}

/** Run fn whenever resyncSeq changes (not on mount). */
export function useResync(fn: () => void): void {
  const { resyncSeq } = useSync();
  const seen = useRef(resyncSeq);
  useEffect(() => {
    if (resyncSeq !== seen.current) {
      seen.current = resyncSeq;
      fn();
    }
  }, [resyncSeq, fn]);
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [resyncSeq, setResyncSeq] = useState(0);
  const subsRef = useRef(new Set<(b: WsBatch) => void>());
  const everConnectedRef = useRef(false);

  const queue = useMemo(
    () => createOpQueue(() => setResyncSeq((n) => n + 1)), []);

  useEffect(() => {
    const handle = connectSocket({
      onBatch: (batch) => {
        if (batch.client_id === clientId) return; // our own echo
        subsRef.current.forEach((fn) => fn(batch));
      },
      onStatus: (up) => {
        if (up) {
          if (everConnectedRef.current) setResyncSeq((n) => n + 1);
          everConnectedRef.current = true;
          setStatus("connected");
        } else {
          setStatus("reconnecting");
        }
      },
    });
    return () => handle.close();
  }, []);

  const api = useMemo<Sync>(() => ({
    status,
    resyncSeq,
    enqueue: (ops) => queue.enqueue(ops),
    subscribe: (fn) => {
      subsRef.current.add(fn);
      return () => { subsRef.current.delete(fn); };
    },
  }), [status, resyncSeq, queue]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
```

- [ ] **Step 5: banner + App wiring + proxy**

Create `web/src/components/ReconnectBanner.tsx`:

```tsx
// pattern: Functional Core
import { useSync } from "../sync/SyncProvider";

/** Shown only after a live connection drops; the first connect is silent. */
export function ReconnectBanner() {
  const { status } = useSync();
  if (status !== "reconnecting") return null;
  return <div className="ws-banner" role="status">Reconnecting… editing is paused</div>;
}
```

In `web/src/App.tsx`: wrap the whole shell in `<SyncProvider>` (outermost, inside nothing else) and render `<ReconnectBanner />` as the first child of `.app`:

```tsx
  return (
    <SyncProvider>
      <SidebarContext.Provider value={sidebarApi}>
        <div className="app">
          <ReconnectBanner />
          {/* …existing hamburger/nav/main/sidebar/search unchanged… */}
        </div>
      </SidebarContext.Provider>
    </SyncProvider>
  );
```

In `web/vite.config.ts`, give the API proxy websocket support:

```ts
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8974", ws: true },
      "/assets": "http://127.0.0.1:8974",
      "/login": "http://127.0.0.1:8974",
    },
  },
```

Append to `web/src/styles.css`:

```css
/* --- plan 5: sync --- */
.ws-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: #bf7326; color: #fff; text-align: center; padding: 4px 8px;
  font-size: 13px; }
```

- [ ] **Step 6: Run the full web suite**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass — including the pre-existing App tests, which now mount SyncProvider over the stubbed FakeWebSocket (silent: status stays "connecting", no banner, no network).

- [ ] **Step 7: Commit**

```bash
git add web/src/sync web/src/components/ReconnectBanner.tsx web/src/App.tsx \
  web/src/test-helpers.ts web/src/test-setup.ts web/vite.config.ts web/src/styles.css
git commit -m "feat: websocket sync client, SyncProvider context, reconnect banner"
git push
```

### Task 8: Editable outliner components — focused textarea, keyboard map, collapse + TODO ops

The Roam-feel components: only the focused block is a live auto-growing textarea showing raw markdown; every other block renders through the existing segment pipeline. All state and effects live in the handlers (T10's hook); these components translate DOM events into handler calls, which keeps them testable with `vi.fn()` handlers.

Keyboard contract (spec §4): Enter = split (Shift-Enter = literal newline), Tab/Shift-Tab = indent/outdent, Alt-↑/↓ = move block, ↑/↓ cross blocks at first/last line, ←/→ cross at the ends, Backspace at position 0 = merge/delete, Esc = blur. Cmd-K stays global (App).

**Files:**
- Create: `web/src/components/EditableBlockTree.tsx`
- Modify: `web/src/contexts.ts`, `web/src/components/TodoCheckbox.tsx`, `web/src/styles.css`
- Test: `web/src/components/EditableBlockTree.test.tsx`

**Interfaces:**
- Consumes: `tokenizeBlock`, `InlineSegments`, `FocusTarget` (T5).
- Produces (consumed by T10):
  - `interface OutlineHandlers { onFocusBlock(uid, cursor); onBlurBlock(); onDraftChange(uid, text); onSplit(uid, cursor); onIndent(uid); onOutdent(uid); onMoveUp(uid); onMoveDown(uid); onBackspaceAtStart(uid); onArrow(uid, dir: "up" | "down" | "left" | "right"); onToggleCollapsed(uid, collapsed); onToggleTodo(uid); onFiles(uid, cursor, files: File[]) }`
  - `EditableBlockTree({ blocks, focus, handlers, readOnly })`
  - `contexts.ts`: `BlockEditContext = createContext<{ toggleTodo(): void } | null>(null)` — TodoCheckbox becomes clickable exactly where a provider exists (the editable tree); backlink/query/sidebar renders stay disabled.
  - T9 extends `EditableBlockTree.tsx` with the autocomplete popup — write this task knowing that arrives.

- [ ] **Step 1: failing component tests**

Create `web/src/components/EditableBlockTree.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";
import { block } from "../test-helpers";
import type { OutlineHandlers } from "./EditableBlockTree";
import { EditableBlockTree } from "./EditableBlockTree";

function handlers(): OutlineHandlers {
  return {
    onFocusBlock: vi.fn(), onBlurBlock: vi.fn(), onDraftChange: vi.fn(),
    onSplit: vi.fn(), onIndent: vi.fn(), onOutdent: vi.fn(),
    onMoveUp: vi.fn(), onMoveDown: vi.fn(), onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(), onToggleCollapsed: vi.fn(), onToggleTodo: vi.fn(),
    onFiles: vi.fn(),
  };
}

const BLOCKS = [
  block("u1", "hello [[World]]", { order_idx: 0 }),
  block("u2", "{{[[TODO]]}} task", { order_idx: 1 }),
];

function mount(h: OutlineHandlers, focus: { uid: string; cursor: number } | null,
               readOnly = false) {
  return render(
    <MemoryRouter>
      <EditableBlockTree blocks={BLOCKS} focus={focus} handlers={h}
                         readOnly={readOnly} />
    </MemoryRouter>);
}

function focusedTextarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

test("unfocused blocks render segments; clicking one focuses it at text end", () => {
  const h = handlers();
  mount(h, null);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("link", { name: "World" })).toBeInTheDocument();
  fireEvent.click(screen.getByText(/hello/));
  expect(h.onFocusBlock).toHaveBeenCalledWith("u1", "hello [[World]]".length);
});

test("the focused block is a textarea with the raw markdown", () => {
  mount(handlers(), { uid: "u1", cursor: 5 });
  const ta = focusedTextarea();
  expect(ta.value).toBe("hello [[World]]");
  expect(document.activeElement).toBe(ta);
  expect(ta.selectionStart).toBe(5);
});

test("typing reports the draft", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  fireEvent.change(focusedTextarea(), { target: { value: "hi" } });
  expect(h.onDraftChange).toHaveBeenCalledWith("u1", "hi");
});

test("keyboard map dispatches to the right handlers", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(3, 3);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).toHaveBeenCalledWith("u1", 3);
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(h.onIndent).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
  expect(h.onOutdent).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowUp", altKey: true });
  expect(h.onMoveUp).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowDown", altKey: true });
  expect(h.onMoveDown).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowUp" }); // single-line: crosses up
  expect(h.onArrow).toHaveBeenCalledWith("u1", "up");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "Backspace" });
  expect(h.onBackspaceAtStart).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowLeft" });
  expect(h.onArrow).toHaveBeenCalledWith("u1", "left");
});

test("Shift-Enter does not split (literal newline)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  fireEvent.keyDown(focusedTextarea(), { key: "Enter", shiftKey: true });
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("arrows stay inside a multi-line draft until the edge line", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "line1\nline2" } });
  ta.setSelectionRange(8, 8); // in line2: ArrowUp must NOT cross
  fireEvent.keyDown(ta, { key: "ArrowUp" });
  expect(h.onArrow).not.toHaveBeenCalled();
  fireEvent.keyDown(ta, { key: "ArrowDown" }); // last line: crosses
  expect(h.onArrow).toHaveBeenCalledWith("u1", "down");
});

test("readOnly blocks structural keys but Escape still blurs", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 }, true);
  const ta = focusedTextarea();
  expect(ta).toHaveAttribute("readonly");
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("chevron toggles collapse via handler; todo checkbox toggles via handler", () => {
  const h = handlers();
  const withKids = [block("p", "parent", {
    order_idx: 0, children: [block("k", "kid", { order_idx: 0 })],
  })];
  render(
    <MemoryRouter>
      <EditableBlockTree blocks={withKids} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "toggle children" }));
  expect(h.onToggleCollapsed).toHaveBeenCalledWith("p", true);
});

test("todo checkbox is enabled in the editable tree and reports its uid", () => {
  const h = handlers();
  mount(h, null);
  const box = screen.getByRole("checkbox");
  expect(box).toBeEnabled();
  fireEvent.click(box);
  expect(h.onToggleTodo).toHaveBeenCalledWith("u2");
});

test("collapsed children are hidden", () => {
  const h = handlers();
  const t = [block("p", "parent", {
    order_idx: 0, collapsed: true,
    children: [block("k", "hidden kid", { order_idx: 0 })],
  })];
  render(
    <MemoryRouter>
      <EditableBlockTree blocks={t} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(screen.queryByText("hidden kid")).toBeNull();
});
```

Run: `cd web && pnpm test -- --run src/components/EditableBlockTree.test.tsx` → FAIL.

- [ ] **Step 2: BlockEditContext + clickable TodoCheckbox**

Append to `web/src/contexts.ts`:

```ts
/** Present only inside the editable outline: lets deep segment renders
 * (TODO checkboxes) reach the block's edit handlers. */
export interface BlockEditApi {
  toggleTodo: () => void;
}

export const BlockEditContext = createContext<BlockEditApi | null>(null);
```

Replace `web/src/components/TodoCheckbox.tsx`:

```tsx
// pattern: Functional Core
import { useContext } from "react";
import { BlockEditContext } from "../contexts";

/** Clickable where an edit context exists (the editable outline); read-only
 * everywhere else (backlinks, query results, sidebar panels). */
export function TodoCheckbox({ done }: { done: boolean }) {
  const edit = useContext(BlockEditContext);
  return (
    <input type="checkbox" className="todo-checkbox"
           aria-label={done ? "DONE" : "TODO"}
           checked={done} disabled={edit === null}
           onChange={() => edit?.toggleTodo()} />
  );
}
```

- [ ] **Step 3: implement EditableBlockTree.tsx**

Create `web/src/components/EditableBlockTree.tsx`:

```tsx
// pattern: Imperative Shell
// The outliner. Only the focused block is a live textarea (raw markdown);
// everything else renders through the read pipeline. This file owns DOM
// concerns (focus placement, auto-grow, key mapping) and delegates every
// semantic decision to the handlers (useOutline).
import { useEffect, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import type { FocusTarget } from "../outline/edits";
import { BlockEditContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

export interface OutlineHandlers {
  onFocusBlock(uid: string, cursor: number): void;
  /** Blur reports WHICH block blurred: when a structural op has already
   * moved focus elsewhere, the old textarea's unmount-blur arrives late and
   * must not clear the new focus (the hook checks the uid). */
  onBlurBlock(uid: string): void;
  onDraftChange(uid: string, text: string): void;
  onSplit(uid: string, cursor: number): void;
  onIndent(uid: string): void;
  onOutdent(uid: string): void;
  onMoveUp(uid: string): void;
  onMoveDown(uid: string): void;
  onBackspaceAtStart(uid: string): void;
  onArrow(uid: string, dir: "up" | "down" | "left" | "right"): void;
  onToggleCollapsed(uid: string, collapsed: boolean): void;
  onToggleTodo(uid: string): void;
  onFiles(uid: string, cursor: number, files: File[]): void;
}

interface TreeProps {
  blocks: BlockNode[];
  focus: FocusTarget | null;
  handlers: OutlineHandlers;
  readOnly: boolean;
}

export function EditableBlockTree({ blocks, focus, handlers, readOnly }: TreeProps) {
  return (
    <div className="block-tree">
      {blocks.map((b) => (
        <EditableBlock key={b.uid} node={b} focus={focus} handlers={handlers}
                       readOnly={readOnly} />
      ))}
    </div>
  );
}

function EditableBlock({ node, focus, handlers, readOnly }: {
  node: BlockNode; focus: FocusTarget | null;
  handlers: OutlineHandlers; readOnly: boolean;
}) {
  const focused = focus?.uid === node.uid;
  const hasChildren = node.children.length > 0;
  const Tag: "h1" | "h2" | "h3" | "div" =
    node.heading === 1 ? "h1" :
    node.heading === 2 ? "h2" :
    node.heading === 3 ? "h3" : "div";
  return (
    <div className="block">
      <div className={"block-row" + (focused ? " focused" : "")}>
        <button
          className={"chevron" + (node.collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => handlers.onToggleCollapsed(node.uid, !node.collapsed)}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className="bullet">•</span>
        {focused ? (
          <BlockInput node={node} cursor={focus.cursor} handlers={handlers}
                      readOnly={readOnly} />
        ) : (
          <Tag className="block-text"
               onClick={() => handlers.onFocusBlock(node.uid, node.text.length)}>
            <BlockEditContext.Provider
                value={{ toggleTodo: () => handlers.onToggleTodo(node.uid) }}>
              <InlineSegments segments={tokenizeBlock(node.text)} />
            </BlockEditContext.Provider>
          </Tag>
        )}
      </div>
      {hasChildren && !node.collapsed && (
        <div className="block-children">
          {node.children.map((c) => (
            <EditableBlock key={c.uid} node={c} focus={focus} handlers={handlers}
                           readOnly={readOnly} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockInput({ node, cursor, handlers, readOnly }: {
  node: BlockNode; cursor: number;
  handlers: OutlineHandlers; readOnly: boolean;
}) {
  const [draft, setDraft] = useState(node.text);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Take focus + place the cursor once on mount (this component exists only
  // while its block is the focused one).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const at = Math.min(cursor, el.value.length);
    el.setSelectionRange(at, at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow to fit content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    handlers.onDraftChange(node.uid, e.target.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pos = el.selectionStart;
    const caretOnly = el.selectionStart === el.selectionEnd;
    if (e.key === "Escape") {
      el.blur();
      return;
    }
    if (readOnly) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handlers.onSplit(node.uid, pos);
    } else if (e.key === "Tab") {
      e.preventDefault();
      (e.shiftKey ? handlers.onOutdent : handlers.onIndent)(node.uid);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      (e.key === "ArrowUp" ? handlers.onMoveUp : handlers.onMoveDown)(node.uid);
    } else if (e.key === "Backspace" && pos === 0 && caretOnly) {
      e.preventDefault();
      handlers.onBackspaceAtStart(node.uid);
    } else if (e.key === "ArrowUp" && !draft.slice(0, pos).includes("\n")) {
      e.preventDefault();
      handlers.onArrow(node.uid, "up");
    } else if (e.key === "ArrowDown" && !draft.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      handlers.onArrow(node.uid, "down");
    } else if (e.key === "ArrowLeft" && pos === 0 && caretOnly) {
      e.preventDefault();
      handlers.onArrow(node.uid, "left");
    } else if (e.key === "ArrowRight" && pos === draft.length && caretOnly) {
      e.preventDefault();
      handlers.onArrow(node.uid, "right");
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0 || readOnly) return;
    e.preventDefault();
    handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0 || readOnly) return;
    e.preventDefault();
    handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
  };

  return (
    <textarea ref={ref} className="block-input" rows={1} value={draft}
              readOnly={readOnly}
              onChange={onChange} onKeyDown={onKeyDown}
              onBlur={() => handlers.onBlurBlock(node.uid)}
              onPaste={onPaste} onDrop={onDrop} />
  );
}
```

Append to `web/src/styles.css`:

```css
/* --- plan 5: editor --- */
.block-input { flex: 1; width: 100%; font: inherit; color: inherit;
  line-height: inherit; background: transparent; border: none; outline: none;
  resize: none; padding: 0; margin: 0; overflow: hidden; display: block; }
.block-row.focused { background: #f0f6fa; }
.block-text { cursor: text; min-height: 1.5em; }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass — including plan-4's InlineSegments/BlockTree/QueryBlock tests: the TodoCheckbox render change keeps `disabled` outside an edit context, so read-side snapshots hold.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/EditableBlockTree.tsx web/src/components/EditableBlockTree.test.tsx \
  web/src/components/TodoCheckbox.tsx web/src/contexts.ts web/src/styles.css
git commit -m "feat: editable outliner components with focused-textarea keyboard editing"
git push
```

---

### Task 9: `[[` / `#` page-title autocomplete

Pure detection/insertion core + a `useTitleOptions` fetch hook + a dumb popup rendered under the focused block. The textarea keeps focus throughout; while the popup is open, ↑/↓ move its selection, Enter/Tab pick, Esc closes the popup without blurring. Picking a title inserts `Title]]` (ref) or `#Title` / `#[[Multi Word]]` (tag). A non-matching query offers a "New page:" row — implicit page creation is server-side (`ReindexRefs`), so inserting the text is all it takes.

**Files:**
- Create: `web/src/outline/autocomplete.ts`, `web/src/components/AutocompletePopup.tsx`
- Modify: `web/src/components/EditableBlockTree.tsx` (BlockInput), `web/src/styles.css`
- Test: `web/src/outline/autocomplete.test.ts`, `web/src/components/AutocompletePopup.test.tsx` (integration through BlockInput)

**Interfaces:**
- Consumes: `GET /api/titles` (T2), `TitlesPayload`, `apiFetch`.
- Produces:
  - `autocomplete.ts`: `interface AcContext { kind: "ref" | "tag"; start: number; query: string }` (start = index of the query's first char, after the trigger), `detectAutocomplete(text: string, cursor: number): AcContext | null`, `applyCompletion(text: string, cursor: number, ctx: AcContext, title: string): { text: string; cursor: number }`.
  - `AutocompletePopup.tsx`: `useTitleOptions(query: string | null): string[]` (debounced 150ms, stale-response-guarded, `null` clears) and `AutocompletePopup({ rows, selected, onPick })` with `interface AcRow { title: string; isNew: boolean }`.
  - `EditableBlockTree.tsx` additionally exports nothing new — BlockInput internally wires the popup; its keydown handles popup keys FIRST when open.

- [ ] **Step 1: failing core tests**

Create `web/src/outline/autocomplete.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { applyCompletion, detectAutocomplete } from "./autocomplete";

describe("detectAutocomplete", () => {
  test("open [[ before the cursor", () => {
    expect(detectAutocomplete("see [[Ma", 8)).toEqual(
      { kind: "ref", start: 6, query: "Ma" });
    expect(detectAutocomplete("see [[", 6)).toEqual(
      { kind: "ref", start: 6, query: "" });
  });

  test("#[[ counts as a ref context", () => {
    expect(detectAutocomplete("tag #[[Lo", 9)).toEqual(
      { kind: "ref", start: 7, query: "Lo" });
  });

  test("closed [[..]] does not trigger", () => {
    expect(detectAutocomplete("see [[Done]] after", 18)).toBeNull();
  });

  test("# with at least one tag char", () => {
    expect(detectAutocomplete("a #ta", 5)).toEqual(
      { kind: "tag", start: 3, query: "ta" });
    expect(detectAutocomplete("#x", 2)).toEqual(
      { kind: "tag", start: 1, query: "x" });
    expect(detectAutocomplete("a #", 3)).toBeNull(); // bare # stays quiet
    expect(detectAutocomplete("word#x", 6)).toBeNull(); // mid-word # is not a tag
  });

  test("cursor position matters", () => {
    expect(detectAutocomplete("see [[Ma", 4)).toBeNull();
  });
});

describe("applyCompletion", () => {
  test("ref: inserts title and closes brackets", () => {
    expect(applyCompletion("see [[Ma tail", 8,
                           { kind: "ref", start: 6, query: "Ma" },
                           "Machine Learning"))
      .toEqual({ text: "see [[Machine Learning]] tail", cursor: 24 });
  });

  test("ref: consumes an already-typed closer instead of doubling it", () => {
    expect(applyCompletion("see [[Ma]]", 8,
                           { kind: "ref", start: 6, query: "Ma" },
                           "Machine Learning"))
      .toEqual({ text: "see [[Machine Learning]]", cursor: 24 });
  });

  test("tag: plain for simple titles, #[[..]] for spaced ones", () => {
    expect(applyCompletion("a #ta", 5, { kind: "tag", start: 3, query: "ta" },
                           "tasks"))
      .toEqual({ text: "a #tasks", cursor: 8 });
    expect(applyCompletion("a #ta", 5, { kind: "tag", start: 3, query: "ta" },
                           "Machine Learning"))
      .toEqual({ text: "a #[[Machine Learning]]", cursor: 23 });
  });
});
```

Run: `cd web && pnpm test -- --run src/outline/autocomplete.test.ts` → FAIL.

- [ ] **Step 2: implement the core**

Create `web/src/outline/autocomplete.ts`:

```ts
// pattern: Functional Core
// Detect an open [[ / # completion context at the cursor and splice a picked
// title back into the text. Tag charset mirrors tokenize.ts (#[A-Za-z0-9_/-]);
// anything else gets the #[[Long Title]] form.
export interface AcContext {
  kind: "ref" | "tag";
  start: number; // index of the query's first char (after the trigger)
  query: string;
}

const PLAIN_TAG_RE = /^[A-Za-z0-9_/-]+$/;

export function detectAutocomplete(text: string,
                                   cursor: number): AcContext | null {
  const before = text.slice(0, cursor);
  const open = before.lastIndexOf("[[");
  if (open !== -1) {
    const between = before.slice(open + 2);
    if (!between.includes("]]") && !between.includes("\n")) {
      return { kind: "ref", start: open + 2, query: between };
    }
  }
  const hash = before.lastIndexOf("#");
  if (hash !== -1 && (hash === 0 || /\s/.test(before[hash - 1]))) {
    const between = before.slice(hash + 1);
    if (between !== "" && PLAIN_TAG_RE.test(between)) {
      return { kind: "tag", start: hash + 1, query: between };
    }
  }
  return null;
}

export function applyCompletion(text: string, cursor: number, ctx: AcContext,
                                title: string): { text: string; cursor: number } {
  const after = text.slice(cursor);
  if (ctx.kind === "ref") {
    const rest = after.startsWith("]]") ? after.slice(2) : after;
    const head = text.slice(0, ctx.start) + title + "]]";
    return { text: head + rest, cursor: head.length };
  }
  const inserted = PLAIN_TAG_RE.test(title) ? title : `[[${title}]]`;
  const head = text.slice(0, ctx.start) + inserted;
  return { text: head + after, cursor: head.length };
}
```

Run: `cd web && pnpm test -- --run src/outline/autocomplete.test.ts` → PASS.

- [ ] **Step 3: failing integration test through BlockInput**

Create `web/src/components/AutocompletePopup.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";
import { block, stubFetch } from "../test-helpers";
import type { OutlineHandlers } from "./EditableBlockTree";
import { EditableBlockTree } from "./EditableBlockTree";

// state updates land during timer advances: keep React quiet with act()
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function handlers(): OutlineHandlers {
  return {
    onFocusBlock: vi.fn(), onBlurBlock: vi.fn(), onDraftChange: vi.fn(),
    onSplit: vi.fn(), onIndent: vi.fn(), onOutdent: vi.fn(),
    onMoveUp: vi.fn(), onMoveDown: vi.fn(), onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(), onToggleCollapsed: vi.fn(), onToggleTodo: vi.fn(),
    onFiles: vi.fn(),
  };
}

function mount(h: OutlineHandlers) {
  return render(
    <MemoryRouter>
      <EditableBlockTree blocks={[block("u1", "", { order_idx: 0 })]}
                         focus={{ uid: "u1", cursor: 0 }} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
}

function type(value: string) {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value } });
  ta.setSelectionRange(value.length, value.length);
  return ta;
}

test("typing [[ shows title options; Enter picks and closes the brackets", async () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: ["Machine Learning", "Magic"] }]]);
  const h = handlers();
  mount(h);
  const ta = type("see [[Ma");
  await tick(200); // debounce + fetch
  expect(screen.getByRole("option", { name: "Machine Learning" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "ArrowDown" }); // select "Magic"
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled(); // Enter was consumed by the popup
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "see [[Magic]]");
  expect(screen.queryByRole("listbox")).toBeNull(); // popup closed
  vi.useRealTimers();
});

test("a query with no exact match offers a New page row", async () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const h = handlers();
  mount(h);
  const ta = type("[[Fresh Idea");
  await tick(200);
  expect(screen.getByRole("option", { name: /New page: Fresh Idea/ })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[[Fresh Idea]]");
  vi.useRealTimers();
});

test("Escape closes the popup without blurring", async () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: ["Tasks"] }]]);
  const h = handlers();
  mount(h);
  const ta = type("#Ta");
  await tick(200);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(h.onBlurBlock).not.toHaveBeenCalled();
  vi.useRealTimers();
});
```

Run: `cd web && pnpm test -- --run src/components/AutocompletePopup.test.tsx` → FAIL.

- [ ] **Step 4: implement popup + BlockInput integration**

Create `web/src/components/AutocompletePopup.tsx`:

```tsx
// pattern: Imperative Shell
// Title options for the [[ / # popup: debounced fetch with a stale-response
// token (same pattern as SearchModal), plus the dumb popup list itself.
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { TitlesPayload } from "../api/payloads";

const DEBOUNCE_MS = 150;

export function useTitleOptions(query: string | null): string[] {
  const [options, setOptions] = useState<string[]>([]);
  const seqRef = useRef(0);
  useEffect(() => {
    if (query === null || query === "") {
      seqRef.current++;
      setOptions([]);
      return;
    }
    const token = ++seqRef.current;
    const timer = setTimeout(() => {
      apiFetch<TitlesPayload>(`/api/titles?q=${encodeURIComponent(query)}`)
        .then((p) => { if (token === seqRef.current) setOptions(p.titles); })
        .catch(() => { if (token === seqRef.current) setOptions([]); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  return options;
}

export interface AcRow {
  title: string;
  isNew: boolean;
}

export function buildRows(options: string[], query: string): AcRow[] {
  const rows: AcRow[] = options.map((t) => ({ title: t, isNew: false }));
  const exact = options.some((t) => t.toLowerCase() === query.toLowerCase());
  if (query !== "" && !exact) rows.push({ title: query, isNew: true });
  return rows;
}

export function AutocompletePopup({ rows, selected, onPick }: {
  rows: AcRow[]; selected: number; onPick: (row: AcRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="ac-popup" role="listbox">
      {rows.map((row, i) => (
        <div key={`${row.isNew ? "new" : "t"}-${row.title}`} role="option"
             aria-selected={i === selected}
             className={"ac-row" + (i === selected ? " selected" : "")}
             onMouseDown={(e) => { e.preventDefault(); onPick(row); }}>
          {row.isNew ? <>New page: <b>{row.title}</b></> : row.title}
        </div>
      ))}
    </div>
  );
}
```

In `web/src/components/EditableBlockTree.tsx`, extend `BlockInput`:

```tsx
import { applyCompletion, detectAutocomplete,
         type AcContext } from "../outline/autocomplete";
import { AutocompletePopup, buildRows, useTitleOptions } from "./AutocompletePopup";
```

Inside `BlockInput`, add state and wire it in (full replacement of the component body's state/handlers — keep the mount/auto-grow effects):

```tsx
  const [draft, setDraft] = useState(node.text);
  const [ac, setAc] = useState<AcContext | null>(null);
  const [acSelected, setAcSelected] = useState(0);
  const [caret, setCaret] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const options = useTitleOptions(ac ? ac.query : null);
  const acRows = ac ? buildRows(options, ac.query) : [];

  const setText = (text: string, cursor: number) => {
    setDraft(text);
    handlers.onDraftChange(node.uid, text);
    // place the cursor after React commits the new value
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(cursor, cursor);
    });
  };

  const pick = (row: { title: string }) => {
    if (!ac) return;
    const applied = applyCompletion(draft, caret, ac, row.title);
    setAc(null);
    setAcSelected(0);
    setText(applied.text, applied.cursor);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const pos = e.target.selectionStart;
    setDraft(value);
    setCaret(pos);
    setAcSelected(0);
    setAc(detectAutocomplete(value, pos));
    handlers.onDraftChange(node.uid, value);
  };
```

and put the popup keys at the TOP of `onKeyDown` (before everything else):

```tsx
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acRows.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcSelected((s) => Math.min(s + 1, acRows.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(acRows[acSelected]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAc(null);
        return;
      }
    }
    // …existing key map from T8 unchanged below…
```

Render the popup inside a relative wrapper (replace the bare `<textarea …/>` return):

```tsx
  return (
    <div className="block-input-wrap">
      <textarea ref={ref} className="block-input" rows={1} value={draft}
                readOnly={readOnly}
                onChange={onChange} onKeyDown={onKeyDown}
                onBlur={() => handlers.onBlurBlock(node.uid)}
                onPaste={onPaste} onDrop={onDrop} />
      {!readOnly && (
        <AutocompletePopup rows={acRows} selected={acSelected} onPick={pick} />
      )}
    </div>
  );
```

Append to `web/src/styles.css`:

```css
.block-input-wrap { position: relative; flex: 1; min-width: 0; }
.ac-popup { position: absolute; top: 100%; left: 0; z-index: 50;
  background: #fff; border: 1px solid #d3dbe1; border-radius: 4px;
  box-shadow: 0 4px 14px rgba(16, 22, 26, 0.15); min-width: 240px;
  max-height: 40vh; overflow-y: auto; }
.ac-row { padding: 4px 10px; cursor: pointer; }
.ac-row.selected { background: #eef4f8; }
```

- [ ] **Step 5: Run the full web suite**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass, including T8's tests (the popup only intercepts keys when it has rows, so the plain keyboard-map tests are unaffected — their fetch stub returns 404 for `/api/titles`, and the empty-draft tests never open a context).

- [ ] **Step 6: Commit**

```bash
git add web/src/outline/autocomplete.ts web/src/outline/autocomplete.test.ts \
  web/src/components/AutocompletePopup.tsx web/src/components/AutocompletePopup.test.tsx \
  web/src/components/EditableBlockTree.tsx web/src/styles.css
git commit -m "feat: [[ and # page-title autocomplete in the block editor"
git push
```

### Task 10: `useOutline` hook, `EditablePage`, PageView + Journal wiring

The imperative-shell hook that owns one page's editable outline — block state, focus, the 500ms text-op debounce, command dispatch into T5's pure edits, op enqueueing, and remote-batch application — plus the `EditablePage` component and the switch-over of PageView and the Journal from read-only `BlockTree` to the editor. Includes the empty-page/empty-day "Click to start writing…" affordance (the create op auto-creates the page server-side, so a not-yet-existing journal day needs nothing special).

Draft model (why text is NOT state-per-keystroke): the focused `BlockInput` owns its draft locally; the hook only holds a `pendingRef` and flushes it as an `update_text` op after 500ms idle, on blur, or **before any structural op** (so op order is always text-then-structure). Remote `update_text` ops for the block being typed in are skipped — our draft wins on its next flush (per-block last-write-wins, spec). Pending text can be lost only by closing the tab within the debounce window — accepted for v1 (blur, navigation, and every structural key all flush first).

**Files:**
- Create: `web/src/outline/useOutline.ts`, `web/src/views/EditablePage.tsx`
- Modify: `web/src/views/PageView.tsx`, `web/src/views/Journal.tsx`, `web/src/components/EditableBlockTree.tsx` (onBlurBlock gains the uid arg — see Step 1), `web/src/test-helpers.ts`, `web/src/styles.css`
- Test: `web/src/views/EditablePage.test.tsx` (new), `web/src/views/PageView.test.tsx`, `web/src/views/Journal.test.tsx` (expectation updates)

**Interfaces:**
- Consumes: T5 edits, T4 tree utils, T7 `useSync`/`useResync`, T8 `OutlineHandlers`/`EditableBlockTree`.
- Produces:
  - `useOutline(pageTitle: string, initial: BlockNode[]): Outline` where `interface Outline { blocks; focus; readOnly: boolean; handlers: OutlineHandlers; createFirstBlock(): void; appendBlock(text: string): void }` (`appendBlock` is T12's composer entry point).
  - `EditablePage({ title, initial }: { title: string; initial: BlockNode[] })`.
  - `test-helpers.ts`: `makeSync()` — a controllable `Sync` fake exposing `sent: BlockOp[][]` and `emit(batch)`.

- [ ] **Step 1: understand the unmount-blur race (no code — it shapes the hook)**

When Enter moves focus to a freshly created block, the OLD textarea unmounts and fires a native blur AFTER the hook has already set the new focus; a bare "clear focus on blur" would kill it. That is why `OutlineHandlers.onBlurBlock(uid)` (T8) reports which block blurred: the hook below clears focus only if that block still owns it.

- [ ] **Step 2: makeSync test helper**

Append to `web/src/test-helpers.ts`:

```ts
import type { BlockOp } from "./api/ops";
import type { WsBatch } from "./sync/socket";
import type { Sync, SyncStatus } from "./sync/SyncProvider";

export interface SyncFake extends Sync {
  sent: BlockOp[][];
  emit(batch: WsBatch): void;
}

export function makeSync(status: SyncStatus = "connected"): SyncFake {
  const subs = new Set<(b: WsBatch) => void>();
  const sent: BlockOp[][] = [];
  return {
    status,
    resyncSeq: 0,
    enqueue: (ops) => { sent.push(ops); },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    sent,
    emit: (batch) => subs.forEach((fn) => fn(batch)),
  };
}
```

(merge the type imports with the file's existing import block).

- [ ] **Step 3: failing EditablePage tests**

Create `web/src/views/EditablePage.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { block, makeSync, stubFetch } from "../test-helpers";
import { SyncContext } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

afterEach(() => vi.useRealTimers());

function mount(sync = makeSync(), initial = [
  block("u1", "first", { order_idx: 0 }),
  block("u2", "second", { order_idx: 1 }),
]) {
  render(
    <MemoryRouter>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={initial} />
      </SyncContext.Provider>
    </MemoryRouter>);
  return sync;
}

function focusBlock(text: string): HTMLTextAreaElement {
  fireEvent.click(screen.getByText(text));
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

test("typing flushes one update_text op after the debounce", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first edited" } });
  expect(sync.sent).toEqual([]);
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "first edited" }],
  ]);
});

test("Enter splits: pending text flushes first, create follows, focus moves", () => {
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first!" } });
  ta.setSelectionRange(6, 6);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(sync.sent).toHaveLength(1);
  const batch = sync.sent[0];
  expect(batch[0]).toEqual({ op: "update_text", uid: "u1", text: "first!" });
  expect(batch[1]).toMatchObject({ op: "create", page_title: "Page",
                                   parent_uid: null, order_idx: 1, text: "" });
  // the new block's textarea is now the focused one (empty draft)
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

test("Tab indents the second block under the first", () => {
  stubFetch([]);
  const sync = mount();
  const ta = focusBlock("second");
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(sync.sent).toEqual([
    [{ op: "move", uid: "u2", parent_uid: "u1", order_idx: 0 }],
  ]);
});

test("remote batches patch the tree; own-echo filtering is the provider's job", () => {
  const sync = mount();
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "create", uid: "r1", page_title: "Page", parent_uid: null,
      order_idx: 2, text: "from the iPad" },
  ] }));
  expect(screen.getByText("from the iPad")).toBeInTheDocument();
});

test("remote update_text for the focused block is skipped (draft wins)", () => {
  const sync = mount();
  focusBlock("first");
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "clobbered" },
    { op: "update_text", uid: "u2", text: "second remote" },
  ] }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first");
  expect(screen.getByText("second remote")).toBeInTheDocument();
});

test("empty page shows the start-writing affordance which creates block zero", () => {
  const sync = mount(makeSync(), []);
  fireEvent.click(screen.getByRole("button", { name: /start writing/i }));
  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0][0]).toMatchObject({ op: "create", page_title: "Page",
                                          parent_uid: null, order_idx: 0, text: "" });
  expect(screen.getByRole("textbox")).toBeInTheDocument();
});

test("editing is read-only while the socket is not connected", () => {
  mount(makeSync("connecting"));
  const ta = focusBlock("first");
  expect(ta).toHaveAttribute("readonly");
});
```

Run: `cd web && pnpm test -- --run src/views/EditablePage.test.tsx` → FAIL.

- [ ] **Step 4: implement useOutline**

Create `web/src/outline/useOutline.ts`:

```ts
// pattern: Imperative Shell
// Owns one page's editable outline: block state, focus, the text-op
// debounce, and the wiring between pure edit commands, the op queue, and
// remote websocket batches. All op semantics live in edits.ts / tree.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { OutlineHandlers } from "../components/EditableBlockTree";
import { toggleTodo } from "../grammar/todo";
import { useSync } from "../sync/SyncProvider";
import { newUid } from "../uid";
import { backspaceAtStart, indentBlock, moveBlockDown, moveBlockUp,
         outdentBlock, setCollapsed, splitBlock,
         type EditResult, type FocusTarget } from "./edits";
import { applyOps, findNode, visibleNeighbor } from "./tree";

const TEXT_DEBOUNCE_MS = 500;

export interface Outline {
  blocks: BlockNode[];
  focus: FocusTarget | null;
  readOnly: boolean;
  handlers: OutlineHandlers;
  createFirstBlock(): void;
  appendBlock(text: string): void;
}

export function useOutline(pageTitle: string, initial: BlockNode[]): Outline {
  const sync = useSync();
  const [blocks, setBlocks] = useState(initial);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const pendingRef = useRef<{ uid: string; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new `initial` identity is authoritative state (refetch / navigation):
  // adopt it and drop any pending draft op.
  useEffect(() => {
    setBlocks(initial);
    blocksRef.current = initial;
    pendingRef.current = null;
  }, [initial]);

  const takePendingTextOps = useCallback((): BlockOp[] => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return [];
    pendingRef.current = null;
    if (findNode(blocksRef.current, pending.uid)?.text === pending.text) {
      return []; // draft never actually changed the text
    }
    return [{ op: "update_text", uid: pending.uid, text: pending.text }];
  }, []);

  /** Flush any pending text op, run the command against the flushed tree,
   * apply + enqueue everything in order, then move focus. */
  const run = useCallback((fn: (b: BlockNode[]) => EditResult) => {
    const textOps = takePendingTextOps();
    const base = textOps.length > 0
      ? applyOps(blocksRef.current, textOps, pageTitle)
      : blocksRef.current;
    const result = fn(base);
    const ops = [...textOps, ...result.ops];
    if (ops.length === 0) return;
    const next = result.ops.length > 0 ? result.blocks : base;
    blocksRef.current = next;
    setBlocks(next);
    sync.enqueue(ops);
    if (result.focus) setFocus(result.focus);
  }, [takePendingTextOps, pageTitle, sync]);

  const flushNow = useCallback(() => {
    run((b) => ({ blocks: b, ops: [], focus: null }));
  }, [run]);

  // Remote batches: the same applyOps as local edits. Text updates for the
  // block being typed in are skipped — the local draft wins on its next
  // flush (per-block last-write-wins).
  useEffect(() => sync.subscribe((batch) => {
    const ops = batch.ops.filter((op) =>
      !(op.op === "update_text" && op.uid === focusRef.current?.uid));
    blocksRef.current = applyOps(blocksRef.current, ops, pageTitle);
    setBlocks(blocksRef.current);
  }), [sync, pageTitle]);

  const handlers = useMemo<OutlineHandlers>(() => ({
    onFocusBlock: (uid, cursor) => setFocus({ uid, cursor }),
    onBlurBlock: (uid) => {
      flushNow();
      // Only clear if this block still owns focus — a structural op may
      // already have moved it (the old textarea's unmount-blur arrives late).
      setFocus((f) => (f?.uid === uid ? null : f));
    },
    onDraftChange: (uid, text) => {
      pendingRef.current = { uid, text };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushNow, TEXT_DEBOUNCE_MS);
    },
    onSplit: (uid, cursor) =>
      run((b) => splitBlock(b, pageTitle, uid, cursor, newUid())),
    onIndent: (uid) => run((b) => indentBlock(b, pageTitle, uid)),
    onOutdent: (uid) => run((b) => outdentBlock(b, pageTitle, uid)),
    onMoveUp: (uid) => run((b) => moveBlockUp(b, pageTitle, uid)),
    onMoveDown: (uid) => run((b) => moveBlockDown(b, pageTitle, uid)),
    onBackspaceAtStart: (uid) => run((b) => backspaceAtStart(b, pageTitle, uid)),
    onArrow: (uid, dir) => {
      const to = visibleNeighbor(blocksRef.current, uid,
        dir === "up" || dir === "left" ? "up" : "down");
      if (!to) return;
      flushNow();
      const node = findNode(blocksRef.current, to);
      setFocus({
        uid: to,
        cursor: dir === "down" || dir === "right" ? 0 : (node?.text.length ?? 0),
      });
    },
    onToggleCollapsed: (uid, collapsed) =>
      run((b) => setCollapsed(b, pageTitle, uid, collapsed)),
    onToggleTodo: (uid) => run((b) => {
      const node = findNode(b, uid);
      const flipped = node ? toggleTodo(node.text) : null;
      if (flipped === null) return { blocks: b, ops: [], focus: null };
      const ops: BlockOp[] = [{ op: "update_text", uid, text: flipped }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    }),
    onFiles: () => undefined, // wired in T11 (paste/drop upload)
  }), [run, flushNow, pageTitle]);

  const createFirstBlock = useCallback(() => {
    run((b) => {
      if (b.length > 0) return { blocks: b, ops: [], focus: null };
      const uid = newUid();
      const ops: BlockOp[] = [{ op: "create", uid, page_title: pageTitle,
                                parent_uid: null, order_idx: 0, text: "" }];
      return { blocks: applyOps(b, ops, pageTitle), ops,
               focus: { uid, cursor: 0 } };
    });
  }, [run, pageTitle]);

  const appendBlock = useCallback((text: string) => {
    run((b) => {
      const uid = newUid();
      const last = b[b.length - 1];
      const ops: BlockOp[] = [{ op: "create", uid, page_title: pageTitle,
                                parent_uid: null,
                                order_idx: last ? last.order_idx + 1 : 0,
                                text }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    });
  }, [run, pageTitle]);

  return {
    blocks,
    focus,
    readOnly: sync.status !== "connected",
    handlers,
    createFirstBlock,
    appendBlock,
  };
}
```

- [ ] **Step 5: implement EditablePage**

Create `web/src/views/EditablePage.tsx`:

```tsx
// pattern: Imperative Shell
import type { BlockNode } from "../api/payloads";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day). */
export function EditablePage({ title, initial }: {
  title: string;
  initial: BlockNode[];
}) {
  const outline = useOutline(title, initial);
  if (outline.blocks.length === 0) {
    return (
      <button className="empty-page" disabled={outline.readOnly}
              onClick={() => outline.createFirstBlock()}>
        Click to start writing…
      </button>
    );
  }
  return (
    <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                       handlers={outline.handlers}
                       readOnly={outline.readOnly} />
  );
}
```

Append to `web/src/styles.css`:

```css
.empty-page { display: block; width: 100%; text-align: left; color: #8a9ba8;
  background: none; border: none; padding: 8px 0 24px; cursor: text;
  font: inherit; }
```

- [ ] **Step 6: switch PageView over**

Replace `web/src/views/PageView.tsx` with:

```tsx
// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BacklinksSection } from "../components/BacklinksSection";
import { UnlinkedSection } from "../components/UnlinkedSection";
import { BlockRefContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

export function PageView() {
  const { pathname } = useLocation();
  const title = titleFromPathname(pathname);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const token = ++seqRef.current;
    setError(null);
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (token === seqRef.current) setPayload(p); })
      .catch((e: unknown) => {
        if (token === seqRef.current) setError(String(e));
      });
  }, [title]);

  useEffect(() => { setPayload(null); load(); }, [load]);
  useResync(load); // rejected batch or reconnect: refetch authoritative state
  useEffect(() => { document.title = `${title} — pkm`; }, [title]);

  if (error) return <p className="error">Could not load "{title}": {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefContext.Provider value={payload.block_ref_texts}>
      <article className="page">
        <h1 className="page-title">{payload.page.title}</h1>
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} />
      </article>
      <BacklinksSection key={`bl-${title}`} title={title} initial={payload.backlinks} />
      <UnlinkedSection key={`ul-${title}`} title={title} />
    </BlockRefContext.Provider>
  );
}
```

(`page_title` on create ops must be the server's exact title, so `EditablePage` gets `payload.page.title`, not the URL-derived string. Backlink/unlinked sections are snapshots until the next navigation/refetch — accepted for v1.)

- [ ] **Step 7: switch the Journal over**

In `web/src/views/Journal.tsx`:
- replace the `BlockTree` import with `EditablePage`, add `import { useResync } from "../sync/SyncProvider";`
- day rendering becomes:

```tsx
        <section className="journal-day" key={day.date}>
          <h1 className="page-title">
            <Link to={pagePath(day.title)}>{day.title}</Link>
          </h1>
          <EditablePage title={day.title} initial={day.blocks} />
        </section>
```

(the `day.exists`/"No notes" branch disappears — an empty or not-yet-existing day IS the empty-page affordance; the first create op materialises the page server-side)
- add a full reset for desync, after `loadMore` is defined:

```tsx
  const reset = useCallback(() => {
    daysRef.current = [];
    setDays([]);
    emptyStreakRef.current = 0;
    setAutoLoad(true);
    void loadMore();
  }, [loadMore]);
  useResync(reset);
```

(a desync mid-scroll rewinds to today — rare enough to be fine, and always authoritative)

- [ ] **Step 8: run everything; update displaced expectations**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: EditablePage tests pass. `Journal.test.tsx` / `PageView.test.tsx` / `App.test.tsx` need mechanical updates where they asserted read-only artifacts:
- "No notes" → the affordance button (`screen.getByRole("button", { name: /start writing/i })`).
- Any interaction with plan-4 `Block`'s local collapse toggle inside PageView/Journal → now emits a `set_collapsed` op through the default (no-op) SyncContext; assert on the rendered hide/show only if the test drove it — with the default context `status` is `"connecting"`, so the chevron still works (it's a handler, not gated by readOnly) but state now lives in the hook.
- Everything else (fetch URLs, infinite scroll, error paths) is untouched.

Expected after updates: all pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/outline/useOutline.ts web/src/views/EditablePage.tsx \
  web/src/views/EditablePage.test.tsx web/src/views/PageView.tsx web/src/views/Journal.tsx \
  web/src/views/PageView.test.tsx web/src/views/Journal.test.tsx \
  web/src/components/EditableBlockTree.tsx web/src/test-helpers.ts web/src/styles.css
git commit -m "feat: editable page and journal - useOutline hook wires editor, ops, and live sync"
git push
```

---

### Task 11: Paste / drop image upload in the editor

`POST /api/assets` exists since plan 3. Pasting or dropping files into a focused block uploads them and splices `![filename](/assets/<sha>/<name>)` (or a plain link for non-images — PDFs then render through the existing `PdfEmbed`) into the block text at the cursor, as a normal `update_text` op.

**Files:**
- Create: `web/src/sync/assets.ts`
- Modify: `web/src/outline/useOutline.ts` (the `onFiles` handler)
- Test: `web/src/sync/assets.test.ts`, extend `web/src/views/EditablePage.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, T10's `run`/`findNode`/`applyOps`; T8's BlockInput already forwards paste/drop `File[]`s to `onFiles(uid, cursor, files)`.
- Produces: `uploadAsset(file: File): Promise<AssetInfo>` where `interface AssetInfo { sha256; filename; mime; size; url }` (the server's upload response shape); `assetMarkdown(info: AssetInfo): string`.

- [ ] **Step 1: failing tests**

Create `web/src/sync/assets.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { jsonResponse } from "../test-helpers";
import { assetMarkdown, uploadAsset } from "./assets";

const INFO = { sha256: "ab".repeat(32), filename: "cat.png",
               mime: "image/png", size: 3, url: `/assets/${"ab".repeat(32)}/cat.png` };

test("uploadAsset POSTs multipart form data to /api/assets", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
    return jsonResponse(INFO);
  });
  vi.stubGlobal("fetch", mock);
  const info = await uploadAsset(new File(["abc"], "cat.png", { type: "image/png" }));
  expect(info).toEqual(INFO);
  expect(mock).toHaveBeenCalledWith("/api/assets", expect.anything());
});

test("assetMarkdown: image embed for images, plain link otherwise", () => {
  expect(assetMarkdown(INFO)).toBe(`![cat.png](${INFO.url})`);
  expect(assetMarkdown({ ...INFO, filename: "doc.pdf", mime: "application/pdf" }))
    .toBe(`[doc.pdf](${INFO.url})`);
});
```

Append to `web/src/views/EditablePage.test.tsx`:

```tsx
test("pasting an image uploads it and splices markdown at the cursor", async () => {
  const url = `/assets/${"cd".repeat(32)}/pic.png`;
  stubFetch([["/api/assets", { sha256: "cd".repeat(32), filename: "pic.png",
                               mime: "image/png", size: 3, url }]]);
  const sync = mount();
  const ta = focusBlock("first");
  ta.setSelectionRange(5, 5);
  fireEvent.paste(ta, {
    clipboardData: {
      files: [new File(["png"], "pic.png", { type: "image/png" })],
    },
  });
  await vi.waitFor(() => {
    expect(sync.sent.flat()).toContainEqual({
      op: "update_text", uid: "u1", text: `first![pic.png](${url})`,
    });
  });
});
```

(the paste test runs with real timers — no `vi.useFakeTimers()` — so the upload promise resolves under `vi.waitFor`)

Run: `cd web && pnpm test -- --run src/sync/assets.test.ts src/views/EditablePage.test.tsx` → FAIL.

- [ ] **Step 2: implement assets.ts**

Create `web/src/sync/assets.ts`:

```ts
// pattern: Imperative Shell
// Upload a pasted/dropped/picked file and describe it as block markdown.
import { apiFetch } from "../api/client";

export interface AssetInfo {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
}

export function uploadAsset(file: File): Promise<AssetInfo> {
  const form = new FormData();
  form.append("file", file);
  // no Content-Type header: the browser sets the multipart boundary
  return apiFetch<AssetInfo>("/api/assets", { method: "POST", body: form });
}

export function assetMarkdown(info: AssetInfo): string {
  return info.mime.startsWith("image/")
    ? `![${info.filename}](${info.url})`
    : `[${info.filename}](${info.url})`;
}
```

- [ ] **Step 3: wire onFiles in useOutline**

In `web/src/outline/useOutline.ts`, add `import { assetMarkdown, uploadAsset } from "../sync/assets";` and replace the `onFiles` stub inside the handlers memo:

```ts
    onFiles: (uid, cursor, files) => {
      void (async () => {
        let inserted = "";
        for (const file of files) {
          try {
            inserted += (inserted ? " " : "") + assetMarkdown(await uploadAsset(file));
          } catch {
            // failed upload: leave the text untouched rather than half-splice
          }
        }
        if (inserted === "") return;
        run((b) => {
          const node = findNode(b, uid);
          if (!node) return { blocks: b, ops: [], focus: null };
          const at = Math.min(cursor, node.text.length);
          const text = node.text.slice(0, at) + inserted + node.text.slice(at);
          const ops: BlockOp[] = [{ op: "update_text", uid, text }];
          return { blocks: applyOps(b, ops, pageTitle), ops,
                   focus: { uid, cursor: at + inserted.length } };
        });
      })();
    },
```

(the splice happens against the flushed tree when the upload completes; if the user typed during the upload their pending draft is flushed first by `run`, and the insert position is clamped — a moved cursor during a slow upload lands the image at the pre-paste offset, accepted for v1)

- [ ] **Step 4: Run, tidy the paste test if needed, full suite**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass. (If the yield hack in the paste test is flaky, replace it with `await sync.idle?.()`-style waiting — `vi.waitFor` alone is normally enough; delete the placeholder `findByText` line.)

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/assets.ts web/src/sync/assets.test.ts \
  web/src/outline/useOutline.ts web/src/views/EditablePage.test.tsx
git commit -m "feat: paste/drop image upload into blocks via /api/assets"
git push
```

---

### Task 12: Phone composer

Spec: phone (< 600px) must view everything and APPEND — a fixed bottom composer with text (+`[[` autocomplete) and image upload from the camera / photo library; no outline manipulation on touch. Tap-to-edit block text already works (T8's tap → textarea; structural keys simply don't exist on touch). The composer appends a top-level block to the current page — PageView's page, or today's day on the journal. Desktop hides it purely via CSS.

**Files:**
- Create: `web/src/components/Composer.tsx`
- Modify: `web/src/views/EditablePage.tsx` (composer prop), `web/src/views/PageView.tsx`, `web/src/views/Journal.tsx` (today only), `web/src/styles.css`
- Test: `web/src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: T9 autocomplete core + `useTitleOptions`/`buildRows`/`AutocompletePopup`, T11 `uploadAsset`/`assetMarkdown`, T10 `appendBlock`.
- Produces: `Composer({ onSend, readOnly }: { onSend(text: string): void; readOnly: boolean })`; `EditablePage` gains optional `composer?: boolean` (default false).

- [ ] **Step 1: failing tests**

Create `web/src/components/Composer.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { Composer } from "./Composer";

test("send delivers trimmed text and clears the box", () => {
  const onSend = vi.fn();
  render(<Composer onSend={onSend} readOnly={false} />);
  const ta = screen.getByRole("textbox", { name: "Add to this page" });
  fireEvent.change(ta, { target: { value: "  hello [[World]]  " } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(onSend).toHaveBeenCalledWith("hello [[World]]");
  expect((ta as HTMLTextAreaElement).value).toBe("");
});

test("empty text does not send; readOnly disables everything", () => {
  const onSend = vi.fn();
  const { rerender } = render(<Composer onSend={onSend} readOnly={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(onSend).not.toHaveBeenCalled();
  rerender(<Composer onSend={onSend} readOnly />);
  expect(screen.getByRole("textbox", { name: "Add to this page" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
});

test("picking a photo uploads it and appends markdown to the draft", async () => {
  const url = `/assets/${"ee".repeat(32)}/cam.jpg`;
  stubFetch([["/api/assets", { sha256: "ee".repeat(32), filename: "cam.jpg",
                               mime: "image/jpeg", size: 3, url }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const picker = screen.getByLabelText("Add photo") as HTMLInputElement;
  fireEvent.change(picker, {
    target: { files: [new File(["jpg"], "cam.jpg", { type: "image/jpeg" })] },
  });
  await vi.waitFor(() => {
    expect((screen.getByRole("textbox", { name: "Add to this page" }) as
            HTMLTextAreaElement).value).toBe(`![cam.jpg](${url})`);
  });
});
```

Run: `cd web && pnpm test -- --run src/components/Composer.test.tsx` → FAIL.

- [ ] **Step 2: implement Composer**

Create `web/src/components/Composer.tsx`:

```tsx
// pattern: Imperative Shell
// Phone-only (CSS) fixed bottom composer: append a top-level block to the
// current page with [[ autocomplete and camera/photo-library upload.
import { useRef, useState } from "react";
import { applyCompletion, detectAutocomplete,
         type AcContext } from "../outline/autocomplete";
import { assetMarkdown, uploadAsset } from "../sync/assets";
import { AutocompletePopup, buildRows, useTitleOptions } from "./AutocompletePopup";

export function Composer({ onSend, readOnly }: {
  onSend: (text: string) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [ac, setAc] = useState<AcContext | null>(null);
  const [acSelected, setAcSelected] = useState(0);
  const [caret, setCaret] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const options = useTitleOptions(ac ? ac.query : null);
  const acRows = ac ? buildRows(options, ac.query) : [];

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
    setAc(null);
  };

  const pick = (row: { title: string }) => {
    if (!ac) return;
    const applied = applyCompletion(draft, caret, ac, row.title);
    setDraft(applied.text);
    setAc(null);
    setAcSelected(0);
    requestAnimationFrame(() => {
      taRef.current?.setSelectionRange(applied.cursor, applied.cursor);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    setCaret(e.target.selectionStart);
    setAcSelected(0);
    setAc(detectAutocomplete(e.target.value, e.target.selectionStart));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acRows.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcSelected((s) => Math.min(s + 1, acRows.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAcSelected((s) => Math.max(s - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(acRows[acSelected]); return; }
      if (e.key === "Escape") { e.preventDefault(); setAc(null); return; }
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // same photo can be picked twice
    if (!file) return;
    void uploadAsset(file).then((info) => {
      setDraft((d) => (d === "" ? "" : d + " ") + assetMarkdown(info));
    }).catch(() => undefined);
  };

  return (
    <div className="composer">
      <div className="composer-input-wrap">
        <textarea ref={taRef} aria-label="Add to this page" rows={1}
                  placeholder="Add to this page…" value={draft}
                  disabled={readOnly}
                  onChange={onChange} onKeyDown={onKeyDown} />
        <AutocompletePopup rows={acRows} selected={acSelected} onPick={pick} />
      </div>
      <input ref={fileRef} type="file" accept="image/*" aria-label="Add photo"
             className="composer-file" onChange={onPickFile} />
      <button className="composer-send" onClick={send}
              disabled={readOnly || draft.trim() === ""}>
        Add
      </button>
    </div>
  );
}
```

- [ ] **Step 3: mount it (EditablePage prop + views) and style it**

`web/src/views/EditablePage.tsx` — add the prop and render after the tree/affordance:

```tsx
export function EditablePage({ title, initial, composer = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
}) {
  const outline = useOutline(title, initial);
  return (
    <>
      {outline.blocks.length === 0 ? (
        <button className="empty-page" disabled={outline.readOnly}
                onClick={() => outline.createFirstBlock()}>
          Click to start writing…
        </button>
      ) : (
        <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                           handlers={outline.handlers}
                           readOnly={outline.readOnly} />
      )}
      {composer && (
        <Composer onSend={outline.appendBlock} readOnly={outline.readOnly} />
      )}
    </>
  );
}
```

- PageView: pass `composer` on its `<EditablePage …/>`.
- Journal: pass `composer={i === 0}` — render days with `days.map((day, i) => …)`; the first loaded day is today by construction (the journal starts at today).

Append to `web/src/styles.css`:

```css
/* --- plan 5: phone composer --- */
.composer { display: none; }
@media (max-width: 600px) {
  .composer { display: flex; gap: 8px; align-items: flex-end;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
    padding: 8px; background: #fff; border-top: 1px solid #e1e8ed; }
  .composer-input-wrap { position: relative; flex: 1; min-width: 0; }
  .composer textarea { width: 100%; font: inherit; resize: none;
    border: 1px solid #d3dbe1; border-radius: 6px; padding: 6px 8px; }
  .composer .ac-popup { top: auto; bottom: 100%; }
  .composer-file { max-width: 90px; }
  .composer-send { border: 1px solid #d3dbe1; border-radius: 6px;
    background: #f5f8fa; padding: 6px 12px; }
  .main-pane { padding-bottom: 96px; }
}
```

- [ ] **Step 4: Run the full suite**

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass (Composer is `display: none` on desktop but always in the DOM for PageView/today — jsdom tests that count textboxes now see the composer's; scope existing queries with `{ name: … }` where that bites).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Composer.tsx web/src/components/Composer.test.tsx \
  web/src/views/EditablePage.tsx web/src/views/PageView.tsx web/src/views/Journal.tsx \
  web/src/styles.css
git commit -m "feat: phone bottom composer with autocomplete and photo upload"
git push
```

### Task 13: Playwright smoke — the core editing loop in a real browser

The plan-4 deferral lands here: a real Chromium drives login → journal → create/split/indent → reload-persists → `[[` autocomplete link → navigate → backlink, plus a two-context live-sync check (the flagship WebSocket behaviour, untestable in jsdom). A scratch server bootstrap (fresh empty DB, fixed password, serves `web/dist`) runs under Playwright's `webServer`.

**Files:**
- Create: `server/tests/e2e_serve.py`, `web/playwright.config.ts`, `web/e2e/edit.spec.ts`
- Modify: `web/package.json`, `web/vite.config.ts` (exclude `e2e/` from vitest), `web/.gitignore` (or root `.gitignore`)

**Interfaces:**
- Consumes: `create_app`, `Config`, `DDL`, `hash_password`; the built SPA (`pnpm build`).
- Produces: `pnpm e2e` (build + playwright test) against `http://127.0.0.1:8975`; password `e2e-pw`.

- [ ] **Step 1: install Playwright**

```bash
cd web && pnpm add -D @playwright/test && pnpm exec playwright install chromium
```

Add to `web/package.json` scripts: `"e2e": "pnpm build && playwright test"`.

Exclude e2e specs from vitest in `web/vite.config.ts`:

```ts
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    globals: false,
    exclude: ["e2e/**", "node_modules/**"],
  },
```

Add `test-results/` and `playwright-report/` to `web/.gitignore` (create the file if only a root `.gitignore` exists; keep whichever pattern the repo already uses).

- [ ] **Step 2: scratch-server bootstrap**

Create `server/tests/e2e_serve.py`:

```python
# pattern: Imperative Shell
"""Boot a throwaway server for the Playwright smoke: fresh empty DB in a
temp dir, fixed password "e2e-pw", serves the built SPA from web/dist.
Run: uv run python tests/e2e_serve.py   (from server/)"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import uvicorn

from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config

PORT = 8975
PASSWORD = "e2e-pw"
SALT = bytes.fromhex("11" * 16)


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    web_dist = root / "web" / "dist"
    assert (web_dist / "index.html").is_file(), \
        "web/dist missing - run `pnpm build` first (the e2e script does)"
    data = Path(tempfile.mkdtemp(prefix="pkm-e2e-"))
    db_path = data / "pkm.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript(DDL)
    con.commit()
    con.close()
    (data / "assets").mkdir()
    config = Config(
        db_path=db_path,
        assets_dir=data / "assets",
        password_salt=SALT.hex(),
        password_hash=hash_password(PASSWORD, SALT),
        session_secret="ee" * 32,
        cookie_secure=False,
        web_dist=web_dist,
    )
    uvicorn.run(create_app(config), host="127.0.0.1", port=PORT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: Playwright config**

Create `web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8975" },
  webServer: {
    command: "cd ../server && uv run python tests/e2e_serve.py",
    url: "http://127.0.0.1:8975/healthz",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
```

- [ ] **Step 4: the smoke spec**

Create `web/e2e/edit.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  // wait until the websocket is up (editing unpauses)
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

test("core editing loop: create, split, indent, persist, link, backlink", async ({ page }) => {
  await login(page);
  const today = page.locator(".journal-day").first();
  await expect(today).toBeVisible();

  // fresh DB: today is empty -> the start-writing affordance
  await today.getByText("Click to start writing…").click();
  await input(page).fill("first block");
  await input(page).press("Enter"); // split at end -> new empty sibling
  await input(page).fill("second block");
  await input(page).press("Tab");   // indent under "first block"

  // link via [[ autocomplete: New page row picked with Enter
  await input(page).press("End");
  await input(page).pressSequentially(" [[E2E Target");
  await page.getByRole("option", { name: /New page: E2E Target/ }).click();
  await expect(input(page)).toHaveValue("second block [[E2E Target]]");
  await input(page).press("Escape"); // blur: flushes the draft op

  // persisted across a full reload, structure intact
  await page.reload();
  const day = page.locator(".journal-day").first();
  await expect(day.locator(".block-text", { hasText: "first block" })).toBeVisible();
  const child = day.locator(".block-children .block-text", { hasText: "second block" });
  await expect(child).toBeVisible();

  // the link navigates; the daily page shows up as a backlink
  await child.getByRole("link", { name: "E2E Target" }).click();
  await expect(page).toHaveURL(/\/page\/E2E%20Target/);
  await expect(page.locator(".backlinks")).toContainText("Linked references (1)");
  await expect(page.locator(".backlink-text")).toContainText("second block");
});

test("edits broadcast live to a second client", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a);
  await login(b);

  const dayA = a.locator(".journal-day").first();
  await dayA.locator(".block-text").first().click();
  await input(a).press("End");
  await input(a).press("Enter");
  await input(a).fill("sync-check-42");
  await input(a).press("Escape"); // flush

  // b sees it without reloading (websocket patch)
  await expect(b.locator(".journal-day").first())
    .toContainText("sync-check-42", { timeout: 10_000 });

  await ctxA.close();
  await ctxB.close();
});
```

(Both tests run serially in one file against one server; the second test reuses whatever today's page holds — it only appends. `pressSequentially` types char-by-char so the autocomplete context opens exactly as a human's would.)

- [ ] **Step 5: run it**

Run: `cd web && pnpm e2e`
Expected: 2 passed. Debug failures with `pnpm exec playwright test --headed` and screenshots in `test-results/`.

- [ ] **Step 6: Commit**

```bash
git add server/tests/e2e_serve.py web/playwright.config.ts web/e2e/edit.spec.ts \
  web/package.json web/pnpm-lock.yaml web/vite.config.ts web/.gitignore
git commit -m "test: playwright smoke for the core editing loop and live two-client sync"
git push
```

---

### Task 14: Real-data smoke + findings + plan-6 carry-forwards (verification)

Exercise the editor against a **scratch copy** of the real imported graph (4,313 pages / 52,695 blocks) — never the live file — and record findings in the spec, exactly like plans 2–4 did.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` (append findings subsection)

- [ ] **Step 1: scratch copy + server**

```bash
mkdir -p data/smoke-scratch
uv run --project server python - <<'EOF'
import sqlite3
src = sqlite3.connect("data/pkm.sqlite3")
dst = sqlite3.connect("data/smoke-scratch/pkm.sqlite3")
src.backup(dst)
dst.close(); src.close()
print("scratch copy done")
EOF
```

Record the pre-counts from the REAL db (read-only):

```bash
uv run --project server python - <<'EOF'
import sqlite3
con = sqlite3.connect("file:data/pkm.sqlite3?mode=ro", uri=True)
print("pages", con.execute("select count(*) from pages").fetchone()[0],
      "blocks", con.execute("select count(*) from blocks").fetchone()[0])
EOF
```

Write `data/smoke-scratch/config.json` pointing at the scratch db, the REAL assets dir is NOT used — copy nothing; point `assets_dir` at an empty scratch dir so uploads can't touch real assets; set a known password hash (reuse the e2e_serve.py salt/hash approach), `cookie_secure: false`, and `web_dist: ../../web/dist`. Build the SPA (`cd web && pnpm build`), then run:

```bash
cd server && uv run python -m pkm.server.run --data-dir ../data/smoke-scratch --port 8976
```

- [ ] **Step 2: drive the real graph in a browser**

Log in at `http://127.0.0.1:8976` with a real browser (or the agent-browser/Playwright tooling) and check, noting timings/impressions:

- **Journal home**: today auto-creates; type a line with `[[Paper]]` (autocomplete over 4.3k real titles — how do the suggestions feel latency-wise?); Enter/Tab/Alt-↑ a few blocks.
- **Heavy page**: open `Paper` (371 backlinking pages). Page body editable and snappy? Backlinks still lazy/paginated below? Append a block, verify it appears in a backlink source page after re-navigation.
- **Typing feel on a large page**: open the largest page (find via scratch-db query: `select p.title, count(*) c from blocks b join pages p on p.id=b.page_id group by p.id order by c desc limit 5`) and type mid-outline — any lag from whole-tree re-render on the 500ms flush? (If yes: note it as the known `React.memo`/virtualization fallback, don't fix now.)
- **Two clients**: two browser windows on today's page; edits in one appear live in the other; kill the server → both show "Reconnecting… editing is paused" and blocks/textarea go read-only; restart → banner clears, refetch happens (resync), editing resumes.
- **Rejected batch**: with devtools, hand-POST an invalid batch (`set_collapsed` on a deleted uid) via `fetch` and confirm 400 — then confirm the UI's own desync path by editing normally afterwards (state stays consistent).
- **TODO toggle + collapse**: click a real `{{[[TODO]]}}` checkbox; collapse a subtree; reload — both persisted.
- **Image paste**: paste a screenshot into a block; renders inline; file landed under `data/smoke-scratch/` assets, NOT the real assets dir.
- **Phone breakpoint**: narrow the window < 600px; composer appears; append text with a `[[link]]` and a photo.

- [ ] **Step 3: integrity check + cleanup**

Re-run the read-only count query against the REAL `data/pkm.sqlite3` — counts must be IDENTICAL to Step 1 (the live graph was never opened for writing). Then:

```bash
rm -rf data/smoke-scratch
```

- [ ] **Step 4: record findings + carry-forwards**

Append `### Frontend-edit smoke findings (plan 5)` after the plan-4 findings in `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md`: what was exercised, latencies on the real graph, anything surprising, the explicit real-db pre/post counts, and a `### Frontend-edit carry-forwards (plan 5 final review)` list for plan 6 — seed it with the already-known items:

- plan-3/6 carry-forward still open: asset upload size cap + mime allowlist or `Content-Disposition`/`nosniff` hardening (deployment).
- click-to-focus places the cursor at the block end, not under the pointer (v1 simplification; caret-mapping is the known follow-up).
- backlinks/unlinked sections are snapshots while editing the page above them (refresh on navigation).
- pending draft ops can be lost by closing the tab inside the 500ms debounce window (blur/structural keys/navigation all flush; `visibilitychange` flush is the cheap improvement).
- whatever the smoke itself surfaces.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md
git commit -m "docs: record frontend-edit smoke findings and plan-6 carry-forwards"
git push
```

---

## Self-review notes (completed)

- **Spec coverage (plan-5 scope):** keyboard editing loop ✓ (T5 semantics + T8 key map: Enter split incl. cursor-0 and into-children Roam cases, Shift-Enter literal newline, Tab/Shift-Tab with collapsed-parent auto-expand, Alt-↑/↓ with pre-removal order_idx contract, arrows crossing blocks at edge lines incl. ←/→, Backspace merge/delete, Esc blur); only-focused-block-is-an-input ✓ (T8 BlockInput, drafts local so keystrokes don't re-render the tree); autocomplete `[[`/`#` ✓ (T2 endpoint + T9, `#[[` treated as ref, New-page row, popup keys before editor keys); optimistic ops through the one write path ✓ (T6 queue: coalesce, serialize, desync→refetch; T10 text-flush-before-structure ordering); WS consumption ✓ (T7 provider filters own `client_id`, T10 applies via the same `applyOps`, focused-block text updates skipped per LWW); reconnect banner + writes paused ✓ (T7 status, readOnly everywhere, resync refetch on reconnect — spec's "divergence impossible"); collapse persisted ✓ (T8/T10 `set_collapsed`; plan-4's local-only toggle replaced); TODO checkbox ✓ (T5 toggleTodo preserving bracket-variant leniency + T8 BlockEditContext, read-side stays disabled); implicit page creation ✓ (server-side ReindexRefs; UI needs only the affordance, T10); daily pages ✓ (journal days are EditablePages; empty day = affordance; create auto-creates); phone ✓ (T12 composer <600px with autocomplete + camera upload; tap-to-edit text works, structural ops need hardware keys by design); paste/drop upload ✓ (T11); Playwright smoke ✓ (T13 core loop + two-client sync). Carry-forwards: drift guard EARLY ✓ (T1), non-blocking broadcast ✓ (T1), ErrorBoundary/href-allowlist/404/mergeGroups/a11y ✓ (T3), grammar leniency documented ✓ (T5 comment + T14 note), `MoveOp.order_idx` contract honoured ✓ (T1 exposes order_idx; T4/T5 tested against gap fixtures).
- **Placeholder scan:** every code step carries the actual code; the only intentionally-open items are mechanical test-expectation updates flagged in T10/T12 Step text (they depend on plan-4 test internals the executor sees in situ) and T14's findings (unknowable until run).
- **Type consistency check:** `OutlineHandlers.onBlurBlock(uid)` defined with the uid from T8 on (the unmount-blur race that requires it is explained at T10 Step 1; the T9 Escape test only asserts `not.toHaveBeenCalled()`, so no test cares about the arg); `EditResult`/`FocusTarget` names match between T5 and T8/T10; `applyOps(blocks, ops, pageTitle)` signature identical at every call site; `Sync`/`SyncStatus`/`WsBatch` names match T7 exports and T10 helper imports; `TitlesPayload` produced in T2, consumed in T9; `AssetInfo.url` field used by `assetMarkdown` matches the plan-3 upload response (`routes_assets.py` returns `url`); `block()` helper gains `order_idx` in T1 before T4+ fixtures rely on it.
- **Known accepted v1 limits (recorded in T14 carry-forwards):** cursor-at-end on click-to-focus; snapshot backlinks while editing; debounce-window draft loss on tab close; journal desync resets scroll to today.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-09-frontend-edit.md`. Execute on a worktree branch (`worktree-frontend-edit`) per superpowers:using-git-worktrees, merging with `--no-ff` when finished. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks (superpowers:subagent-driven-development).

**2. Inline Execution** — execute tasks in-session with checkpoints (superpowers:executing-plans).






