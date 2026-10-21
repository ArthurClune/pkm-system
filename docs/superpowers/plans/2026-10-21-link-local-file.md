# /link-local-file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/link-local-file` slash command that opens a browse-or-fuzzy-search picker over the server's local docs folder and inserts `Local copy:: [<name>](/api/local/<encoded path>)` at the cursor.

**Architecture:** The server lists the whole folder (about 770 files) in one response, `GET /api/local-index`. Each entry is a relative path plus the href that `local_docs.local_href` builds for it, so the web app never encodes paths. A scan that blocks on iCloud is abandoned after a timeout and the route answers 503. The web side derives folders from the paths, does browsing and fuzzy search in a Functional Core module, and shows the results in a tree-owned modal (`/upload`'s ownership shape). The pick is spliced in exactly the way `/goodlinks` does it.

**Tech Stack:** FastAPI + Pydantic (server), React 18 + TypeScript + vitest + Playwright (web).

**Spec:** `docs/superpowers/specs/2026-10-21-link-local-file-design.md`

## Global Constraints

- Every file with runtime behaviour starts with `# pattern: Functional Core` / `# pattern: Imperative Shell` (or `// pattern: …` in TS).
- Comments carry no bean ids, line numbers or non-path plan pointers. Comment lines are ≤ 80 columns, code lines ≤ 120. `.githooks/pre-commit` enforces both: run `git config core.hooksPath .githooks` once in the worktree.
- All work happens in `/Users/arthur/code/llm/pkm/.claude/worktrees/link-local-file` on branch `feat/link-local-file`. Never touch `/Users/arthur/code/llm/pkm` directly.
- Never bind port 8974. Give any Playwright run its own `E2E_PORT` (for example 8991).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and never include a Claude session URL.
- The containment rule (`clean_relative` / `is_within`) is never loosened. Anything outside `local_docs_root` is invisible.
- Hrefs come only from `local_docs.local_href`. The web never percent-encodes a path.
- No cap on the number of results (Arthur: silent truncation is worse than a long list).
- Search is case-insensitive.
- No new npm or Python dependency.
- Slash labels are lowercase. The new command is `{ name: "link-local-file", label: "link to local file…" }`.

## Review Focus

1. **Awkward file names:** names with `%`, `#`, `?`, `(`, `)`, `[`, `]` or non-ASCII characters (macOS stores names decomposed). The inserted href must open that exact file. Owned by Task 2: `test_every_index_href_is_served`, a round trip over the whole fixture.
2. **`[`/`]` in a file name** must not break the markdown link. Owned by Task 3: `localCopyAttribute` brackets test.
3. **The block changes while the picker is open** (the block is deleted, or edited elsewhere). The splice must clamp or no-op, never throw. Owned by Task 5: the `onLinkLocalFile` missing-block test.
4. **A configured but empty folder** (or one with only hidden files) shows "No files", not a blank panel. Owned by Task 4.
5. **Picking while the list is still loading, or after closing.** No insert happens after Esc or a click outside. Owned by Task 4: the Esc test asserts `onPick` is never called.

---

### Task 1: Server core: visible names and index order

**Files:**
- Modify: `server/src/pkm/local_docs.py` (add two functions near `local_href`)
- Test: `server/tests/test_local_docs.py`

**Interfaces:**
- Produces:
  - `visible_name(name: str, is_dir: bool) -> str | None`. Returns the name the picker shows, or `None` to skip the entry. Rules:
    - a directory whose name starts with `.` → `None`;
    - a file named `.X.icloud` with `X` non-empty → `X`;
    - any other file whose name starts with `.` → `None`;
    - anything else → the name unchanged.
  - `index_order(rels: Iterable[str]) -> list[str]`. Removes duplicates, then sorts by `(rel.casefold(), rel)`.

- [ ] **Step 1: Write the failing tests**

```python
from pkm.local_docs import index_order, visible_name

def test_visible_name_maps_icloud_stub_to_real_name():
    assert visible_name(".Gone.pdf.icloud", is_dir=False) == "Gone.pdf"

def test_visible_name_hides_dotfiles_and_dot_dirs():
    assert visible_name(".DS_Store", is_dir=False) is None
    assert visible_name(".icloud", is_dir=False) is None
    assert visible_name("..icloud", is_dir=False) is None
    assert visible_name(".Trash", is_dir=True) is None
    assert visible_name("Papers", is_dir=True) == "Papers"
    assert visible_name("50% draft.pdf", is_dir=False) == "50% draft.pdf"

def test_index_order_dedupes_and_sorts_case_insensitively():
    assert index_order(["b/x.pdf", "A/y.pdf", "b/x.pdf", "a/z.pdf"]) == \
        ["A/y.pdf", "a/z.pdf", "b/x.pdf"]
```

- [ ] **Step 2: Run them and confirm they fail.** `cd server && uv run pytest -q tests/test_local_docs.py` → ImportError.
- [ ] **Step 3: Implement both functions in `local_docs.py`.**
- [ ] **Step 4: Run them and confirm they pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `feat(server): local_docs visible_name and index_order for the local index (pkm-12a2)`

---

### Task 2: Server shell: `GET /api/local-index` with a timed scan

**Files:**
- Create: `server/src/pkm/server/local_index.py` (Imperative Shell: the tree walk and `TreeScanner`)
- Modify: `server/src/pkm/server/routes_local.py` (the route), `server/src/pkm/contracts/responses.py` (models)
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts` (per `docs/architecture/backend.md#generated-artifacts-and-parity-fixtures`: run `pkm.server.openapi_dump`, then `cd web && pnpm gen-types`)
- Test: `server/tests/test_local_index.py` (scanner unit tests), `server/tests/test_routes_local.py` (route tests)
- Docs: `docs/architecture/backend.md`. Add a row to the API reference table after `/api/local/check`, add `local_index.py` to the module tree beside `local_open.py`, and add one or two sentences to "Local documents": the index never opens a file, a blocked scan is abandoned on a daemon thread and only one scan is ever in flight, and hrefs come from `local_href`. Use the `architecture-docs` skill.

**Interfaces:**
- Consumes: `visible_name`, `index_order`, `is_within` and `local_href` from `pkm.local_docs`.
- Produces:
  - `responses.py`:
    - `class LocalIndexFile(StrictModel)` with `path: str` (relative, `/`-separated, real name for a stub) and `href: str`;
    - `class LocalIndexPayload(StrictModel)` with `files: list[LocalIndexFile]`. Its docstring names the route and says hrefs come from `local_href`.
  - `local_index.py`:
    - `walk_local_tree(root: Path) -> list[str]`. `root` is already resolved. Recursive `os.scandir`. Symlinks are kept only when `is_within(root, entry.resolve())`. Directories are tracked by resolved path, so a symlink loop is visited once. Names go through `visible_name`, and the result goes through `index_order`. Never opens a file. Lets `OSError` propagate.
    - `class TreeScanner` with `__init__(self, walker: Callable[[Path], list[str]] = walk_local_tree, timeout: float = 5.0)` and `scan(self, root: Path) -> list[str] | None`. `None` means unreadable: timeout, `OSError`, or a missing or non-directory root. The walk runs on a daemon thread (never anyio's pool) and at most one scan is in flight. A caller arriving while one is running joins it, waiting only for what is left of its timeout, the same way `OpenProber.probe` does.
    - `default_scanner = TreeScanner()`.
  - Route: `GET /api/local-index`, `response_model=LocalIndexPayload`, behind `require_auth` (the router's existing dependency).
    - `local_docs_root` unset → 404 `{"detail": "not found"}`.
    - Scan is `None` → 503 with `Retry-After: 5` and `{"detail": "the host can't read the local documents folder"}`.
    - Otherwise each `path` with `href=local_href(path)`.
    - The path sits outside `/api/local/`, so it can't collide with a real file served by the catch-all.

- [ ] **Step 1: Write the failing route tests in `test_routes_local.py`** (use the existing `local_client` / `local_root` / `client` fixtures):

```python
def test_local_index_lists_files_with_hrefs(local_client):
    r = local_client.get("/api/local-index")
    assert r.status_code == 200
    paths = [f["path"] for f in r.json()["files"]]
    assert paths == ["Papers/Gone.pdf", "Papers/ML/50% draft.pdf",
                     "Papers/ML/bundle.zip", "Papers/ML/Title one.pdf"]
    by_path = {f["path"]: f["href"] for f in r.json()["files"]}
    assert by_path["Papers/ML/Title one.pdf"] == local_href("Papers/ML/Title one.pdf")

def test_every_index_href_is_served(local_client, local_root):
    for name in ["a#b.pdf", "q?.pdf", "Programme (Public).pdf",
                 "br[ack]et.pdf", "Café.pdf", "Café nfd.pdf"]:
        (local_root / "Papers" / name).write_bytes(b"%PDF-1.4\n")
    files = local_client.get("/api/local-index").json()["files"]
    for f in files:
        if f["path"] == "Papers/Gone.pdf":
            continue  # evicted stub: the file route answers 503 by design
        assert local_client.get(f["href"]).status_code == 200, f["path"]

def test_local_index_skips_symlinks_out_and_hidden(local_client, local_root):
    outside = local_root.parent / "outside"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"%PDF")
    os.symlink(outside, local_root / "Papers" / "out")
    os.symlink(outside / "secret.pdf", local_root / "Papers" / "s.pdf")
    os.symlink(local_root / "Papers", local_root / "Papers" / "loop")
    (local_root / ".Trash").mkdir()
    (local_root / ".Trash" / "old.pdf").write_bytes(b"%PDF")
    (local_root / "Papers" / ".DS_Store").write_bytes(b"x")
    paths = [f["path"] for f in local_client.get("/api/local-index").json()["files"]]
    assert not any("secret" in p or p.startswith(".") or "DS_Store" in p for p in paths)

def test_local_index_stub_and_real_file_list_once(local_client, local_root):
    (local_root / "Papers" / "Gone.pdf").write_bytes(b"%PDF")
    paths = [f["path"] for f in local_client.get("/api/local-index").json()["files"]]
    assert paths.count("Papers/Gone.pdf") == 1

def test_local_index_404_when_root_unset(client):
    assert client.get("/api/local-index").status_code == 404

def test_local_index_requires_auth(seeded_config, local_root):
    anon = TestClient(create_app(replace(seeded_config, local_docs_root=local_root)))
    assert anon.get("/api/local-index").status_code == 401

@pytest.mark.parametrize("make_root", ["missing", "blocking", "denied"])
def test_local_index_unreadable_is_503(local_client, local_root, monkeypatch, make_root):
    # "missing": rmtree local_root; "blocking": a TreeScanner whose walker waits
    # on an Event (timeout=0.1); "denied": a walker raising PermissionError.
    ...
    r = local_client.get("/api/local-index")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "5"
    assert r.json() == {"detail": "the host can't read the local documents folder"}
```

The parametrised test's setup is the implementer's to write. Blocking and denied patch `routes_local.default_scanner` with `TreeScanner(walker=…, timeout=0.1)` and release the Event in teardown, following the `blocking_prober` fixture.

- [ ] **Step 2: Write the failing scanner unit tests in `test_local_index.py`:**
  - `test_concurrent_callers_share_one_walk`: two threads call `scan` while the walker blocks. Release it. The walker ran once and both callers get the same list.
  - `test_blocked_walk_times_out_and_a_later_call_rejoins_it`: the first call returns `None` after the timeout. A second call while the walk is still blocked returns `None` at once and starts no second walker.
  - `test_walker_oserror_is_none`.

- [ ] **Step 3: Run them and confirm they fail.** `cd server && uv run pytest -q tests/test_local_index.py tests/test_routes_local.py -k "index"` → FAIL (404 / ImportError).
- [ ] **Step 4: Implement `local_index.py`, the two models and the route.**
- [ ] **Step 5: Regenerate the OpenAPI artifacts.** `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`, then `cd ../web && pnpm gen-types`.
- [ ] **Step 6: Run the full server gates.** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` → all pass (`test_openapi_sync` included).
- [ ] **Step 7: Update `backend.md` as listed under Files.**
- [ ] **Step 8: Commit.** `feat(server): GET /api/local-index lists the local docs folder (pkm-12a2)`

---

### Task 3: Web core: folders, fuzzy search and the attribute text

**Files:**
- Create: `web/src/outline/localFiles.ts` (Functional Core)
- Test: `web/src/outline/localFiles.test.ts`

**Interfaces:**
- Consumes: the `LocalIndexFile` shape from the generated types (`{ path: string; href: string }`). Import the type from the API layer the way `outline/goodlinks.ts` imports its types.
- Produces:
  - `export type LocalFile = { path: string; href: string }`, an alias of the generated `LocalIndexFile`.
  - `export function folderListing(files: readonly LocalFile[], folder: string): { folders: string[]; files: LocalFile[] }`. `folder` is `""` for the root or a `/`-joined path with no trailing slash. It returns the immediate child folder names and the files directly in `folder`, each sorted by `localeCompare(…, undefined, { sensitivity: "base" })`.
  - `export function fileName(path: string): string` and `export function folderOf(path: string): string`.
  - `export interface LocalMatch { file: LocalFile; score: number; nameRanges: [number, number][]; folderRanges: [number, number][] }`. The ranges are half-open and index into `fileName(path)` and `folderOf(path)` respectively.
  - `export function searchLocalFiles(files: readonly LocalFile[], query: string): LocalMatch[]`. Every match is returned, best first, with no cap. A query that is empty or only whitespace returns `[]`; the picker browses instead.
  - `export function localCopyAttribute(file: LocalFile): string`. Returns `Local copy:: [<label>](<href>)`, where the label is `fileName(path)` with `[` replaced by `(` and `]` by `)`. `scanMarkdownLinkAt` has no escapes, so an unbalanced bracket in the label would break the link.

The scoring algorithm, which the signature and tests don't settle:
- Lower-case the query and the path.
- Split the query on whitespace. Each word must match as a subsequence of the path, or there is no match.
- For each word, take the first greedy forward match, then tighten it backward from its last matched character (fzf v1). This gives a short window.
- Score per word:
  - +16 per matched character;
  - +8 when the character starts a word (index 0, or the previous character is one of ` /_-.()`);
  - +4 when the previous character also matched;
  - −1 per unmatched character inside the window;
  - +24 when the whole window lies inside the file name.
- Total = the sum over words.
- Sort by score descending, then shorter `path`, then `path` with `localeCompare`.
- Highlight ranges are the union of matched indices, split into the file-name part and the folder part and merged into runs.

- [ ] **Step 1: Write the failing tests**

```ts
const F = (path: string): LocalFile => ({ path, href: `/api/local/${path}` });
const files = [
  F("Papers/Machine Learning/LLMs/SHARED GEOMETRY AS A ROSETTA STONE.pdf"),
  F("Papers/Machine Learning/Underspecification Presents Challenges.pdf"),
  F("Books/Maths/Category theory/Category Theory For Scientists.pdf"),
  F("White Papers/Bitcoin/WEF_DAOs.pdf"),
];

test("folderListing lists child folders and direct files", () => {
  expect(folderListing(files, "")).toEqual({ folders: ["Books", "Papers", "White Papers"], files: [] });
  expect(folderListing(files, "Papers/Machine Learning")).toEqual({
    folders: ["LLMs"], files: [files[1]] });
});

test("fuzzy: subsequence, case-insensitive, every word must match", () => {
  const top = (q: string) => searchLocalFiles(files, q).map((m) => m.file.path);
  expect(top("shrgeo")[0]).toBe(files[0].path);
  expect(top("llm geom")).toEqual([files[0].path]);
  expect(top("LLM GEOM")).toEqual([files[0].path]);
  expect(top("geom zzz")).toEqual([]);
  expect(top("   ")).toEqual([]);
});

test("a file-name match outranks a folder-only match", () => {
  const fs = [F("Category/notes.pdf"), F("Misc/Category theory.pdf")];
  expect(searchLocalFiles(fs, "category").map((m) => m.file.path))
    .toEqual(["Misc/Category theory.pdf", "Category/notes.pdf"]);
});

test("no cap on results", () => {
  const many = Array.from({ length: 900 }, (_, i) => F(`P/paper ${i}.pdf`));
  expect(searchLocalFiles(many, "paper")).toHaveLength(900);
});

test("highlight ranges index into name and folder separately", () => {
  const m = searchLocalFiles([F("Papers/LLMs/Geo.pdf")], "llm geo")[0];
  expect(m.nameRanges).toEqual([[0, 3]]);
  expect(m.folderRanges).toEqual([[7, 10]]);
});

test("localCopyAttribute uses the server href and neutralises brackets", () => {
  expect(localCopyAttribute({ path: "P/br[ack]et.pdf", href: "/api/local/P/br%5Back%5Det.pdf" }))
    .toBe("Local copy:: [br(ack)et.pdf](/api/local/P/br%5Back%5Det.pdf)");
});

test("regex metacharacters in the query are literal", () => {
  expect(searchLocalFiles([F("a/(x).pdf"), F("a/y.pdf")], "(x").map((m) => m.file.path))
    .toEqual(["a/(x).pdf"]);
});
```

- [ ] **Step 2: Run them and confirm they fail.** `cd web && pnpm vitest run src/outline/localFiles.test.ts` → FAIL.
- [ ] **Step 3: Implement `localFiles.ts`.**
- [ ] **Step 4: Run them and confirm they pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `feat(web): localFiles core: folder listing, fuzzy search, Local copy attribute (pkm-12a2)`

---

### Task 4: Web picker component

**Files:**
- Create: `web/src/components/LocalFilePicker.tsx` (Imperative Shell)
- Modify: `web/src/components/useOverlayDismiss.ts`. Widen the first parameter from `RefObject<HTMLButtonElement | null>` to `RefObject<HTMLElement | null>` so the search input can be the focus target. The existing callers are unchanged.
- Modify: `web/src/styles.css`. Add `.local-picker*` rules using the existing design tokens and control classes, with no new tokens. On narrow screens the panel fills the width with a 16px gutter. Read `docs/architecture/styling.md` first.
- Test: `web/src/components/LocalFilePicker.test.tsx` (stub `fetch` the way `GoodlinksReader.test.tsx` does)

**Interfaces:**
- Consumes: `folderListing`, `searchLocalFiles`, `fileName`, `folderOf` and `LocalFile` from Task 3, plus `apiGet("/api/local-index")` and `ApiError` / `OfflineError` from the API layer.
- Produces: `export function LocalFilePicker({ onPick, onClose }: { onPick: (file: LocalFile) => void; onClose: () => void })`.

Behaviour:
- A portal dialog with `role="dialog"`, `aria-modal="true"` and `aria-label="Link a local file"`. Dismissal goes through `useOverlayDismiss(searchRef, onClose)`: Esc, focus starts in the search box, and Tab is pinned to it. A click on the backdrop calls `onClose`.
- It fetches the index once on mount.
- Search box: placeholder `Search all files…`, `aria-label="Search local files"`.
- Empty query (after trimming): a breadcrumb (`nav aria-label="Folder"`) whose segments are buttons, starting with `pkm`. Below it, the result of `folderListing`, folders first. A folder row opens that folder.
- Non-empty query: the output of `searchLocalFiles`. Each row shows the file name with `<mark>` highlights and its folder (`›`-joined) underneath.
- Clearing the query returns to the folder that was being browsed.
- The list is a `role="listbox"`; rows are `role="option"` with `aria-selected`. ↑/↓ move the selection. Enter on a file calls `onPick(file)`; Enter on a folder opens it. A click or tap on a row does the same.
- Messages in place of the list (`role="status"`):
  - while loading: `Loading…`;
  - 404: `Local files aren't set up on this server`;
  - 503: `Couldn't read the local files folder on the server`;
  - `OfflineError`, a network failure or any other error: `Couldn't reach the server`;
  - an empty index or folder: `No files`;
  - a query with no matches: `No matches`.

- [ ] **Step 1: Write the failing tests:**
  - `browses folders from the root and back up via the breadcrumb`
  - `typing searches the whole tree and shows each result's folder`
  - `clearing the search returns to the folder being browsed`
  - `ArrowDown then Enter picks the selected file; clicking a file picks it`
  - `Escape and a backdrop click close without picking` (assert `onPick` not called, `onClose` called once)
  - `shows the not-set-up / unreadable / unreachable messages for 404 / 503 / fetch rejection`
  - `an empty index shows "No files"`
- [ ] **Step 2: Run them and confirm they fail.** `cd web && pnpm vitest run src/components/LocalFilePicker.test.tsx` → FAIL.
- [ ] **Step 3: Implement the component, the `useOverlayDismiss` widening and the CSS.**
- [ ] **Step 4: Run them and confirm they pass**, then run `pnpm typecheck`.
- [ ] **Step 5: Commit.** `feat(web): LocalFilePicker: browse or fuzzy-search the local docs folder (pkm-12a2)`

---

### Task 5: Wire up the slash command, insertion, e2e and docs

**Files:**
- Modify:
  - `web/src/outline/slashCommands.ts`: append `{ name: "link-local-file", label: "link to local file…" }` after `goodlinks`, with a comment in the style of `/goodlinks`.
  - `web/src/components/BlockInput.tsx`: a `"link-local-file"` case in `pick`, the same shape as `/upload`. It computes `at`, closes autocomplete, strips the trigger with `setText`, calls `handlers.onBlurBlock(node.uid)`, then calls the new prop `onRequestLocalFile(node.uid, at)`.
  - `web/src/components/EditableBlockTree.tsx`: tree-owned state `localFileTarget: { uid: BlockUid; at: number } | null` and a stable `requestLocalFile` callback. Thread it through `EditableBlock` beside `onRequestUpload` at every site that prop passes through. Render `<LocalFilePicker>` when the target is set and the tree is neither `fallback` nor `readOnly`. On pick, call `handlers.onLinkLocalFile(target.uid, target.at, file)` and clear the target; on close, just clear it.
  - `web/src/outline/handlers.ts`: add `onLinkLocalFile(uid: BlockUid, cursor: number, file: LocalFile): void`.
  - `web/src/outline/useOutline.ts`: implement `onLinkLocalFile` as `/goodlinks`'s `run(...)` splice, synchronous with no fetch. Use `spliceUploadedMarkdown(node.text, cursor, localCopyAttribute(file))`, return no ops when `findNode` misses, and use the same focus rule.
  - Every test that builds a handlers object (`AutocompletePopup.test.tsx`, `BlockInput.test.tsx`, `EditableBlockTree.test.tsx` and any `pnpm typecheck` names): add `onLinkLocalFile: vi.fn()`.
  - `docs/keyboard.md`: a slash-commands row: `` | `/link-local-file` | Browse or search the server's local documents folder and insert `Local copy:: [file name](…)` for the file you pick | ``. `help/slashCommandsDocumented.test.ts` requires it.
  - `docs/architecture/frontend.md`: module-map entries for `outline/localFiles.ts` and `components/LocalFilePicker.tsx`.
  - `docs/architecture/frontend-editor.md`: in "Slash commands", one sentence saying that `/link-local-file` follows `/upload`'s blur-first, tree-owned shape, opens `LocalFilePicker`, and splices through `useOutline.onLinkLocalFile`.
- Create: `web/e2e/link-local-file.spec.ts`
- Test:
  - `web/src/outline/slashCommands.test.ts`: update the "/goodlinks is the last command" test, since the new command is now last, and assert `matchSlashCommands("link")` returns it.
  - `web/src/components/BlockInput.test.tsx`: picking the command strips the trigger, blurs, and calls `onRequestLocalFile(uid, at)`.
  - A `useOutline` test beside the existing `/goodlinks` one: `onLinkLocalFile` splices the attribute at the offset. On a uid that no longer exists it emits no ops and does not throw.

- [ ] **Step 1: Write the failing unit tests listed above.**
- [ ] **Step 2: Run them and confirm they fail.** `cd web && pnpm vitest run src/outline src/components/BlockInput.test.tsx` → FAIL.
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Write the e2e spec.**
  - Log in the way `local-docs.spec.ts` does, create its own page `Link Local File E2E` with `POST /api/pages`, and delete it in `afterEach`.
  - Type `/link-local-file` in a block, pick the menu row and expect the dialog.
  - Click `Papers`, click `sample.pdf`, and expect the block to render an `Open` button for the PDF embed.
  - Reopen the picker, type `notes`, press Enter, and expect a link named `notes.zip` with href `/api/local/Papers/notes.zip`.
  - The e2e server already seeds `Papers/sample.pdf` and `Papers/notes.zip` in `server/tests/e2e_serve.py`.
- [ ] **Step 5: Run the web gates.** `cd web && set -o pipefail && E2E_PORT=8991 pnpm verify` → typecheck, unit coverage, lint and all of Playwright pass.
- [ ] **Step 6: Run the server gates again.** `cd server && uv run pytest -q` passes, including the comment lint sweep.
- [ ] **Step 7: Commit.** `feat(web): /link-local-file slash command inserts a Local copy:: link (pkm-12a2)`

---

### Task 6: Branch-end checks

- [ ] **Step 1: Run the perf check.** `perf/check.sh` (backend and frontend are picked from the diff). Handle the result per AGENTS.md; a regression means reading your own diff first.
- [ ] **Step 2: Skip the property checks:** this work doesn't touch sync, ops, outline edit commands or undo. Record that in the bean.
- [ ] **Step 3: Grep for stale enumerations.** `grep -rn "slash command" docs/ | grep -i -E "[0-9]+ |ten|eleven|twelve"` and fix any count the new command makes stale.
- [ ] **Step 4: Ask Arthur to try it on the iPad and with a real keyboard** before merge, per his preference for real-keypress checks.
- [ ] **Step 5: Update bean pkm-12a2** with a `## Summary of Changes` and mark it completed once every box is ticked.
