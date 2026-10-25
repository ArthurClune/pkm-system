# Web Clean-ups Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close six low-priority beans (pkm-0zi8, pkm-pvb6, pkm-hrzs, pkm-pgod, pkm-9y7y, pkm-qotb) on one branch, each with a red-first test.

**Architecture:** Each task is self-contained and owns its files; no task consumes another's interface. Two items reach the server: the tag-name class (pkm-9y7y) becomes one generated table that both `refs.py` and `scan.ts` compile, and the staleness stamp (pkm-qotb) lives in `claude_engine.py` as well as `useAssistant.ts`.

**Tech Stack:** TypeScript/React/vitest, sqlite-wasm replica, Python 3.12/pytest, uv, pnpm.

**Spec:** the six bean files under `.beans/` (`pkm-0zi8--*`, `pkm-pvb6--*`, `pkm-hrzs--*`, `pkm-pgod--*`, `pkm-9y7y--*`, `pkm-qotb--*`). Findings that change a bean's scope are stated in that bean's task.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.claude/worktrees/batch-web` (branch `security/batch-web`). Run `pwd` first; never touch `/Users/arthur/code/llm/pkm`.
- The six bean files are already modified (status `in-progress`) and uncommitted. Each task ticks its own bean's checklist boxes in the markdown and commits that bean file with its code. The final task marks all six `completed`.
- FCIS: every new file with runtime behaviour declares `# pattern: ...` / `// pattern: ...`. Generated `.gen.ts` files go in `web/tooling/fcis-exemptions.json`.
- Comments: no bean ids, no line numbers, no spec pointers that are not a path. Comment lines are at most 80 columns; other lines at most 120 (`.gen.ts` is exempt). Never write "load-bearing".
- A property finding's shrunk example goes in a unit test beside the code, never in `web/src/props` or `server/tests/props`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No `Claude-Session:` line, no claude.ai URL.
- Web verification is `cd web && pnpm verify` (with `set -o pipefail` if piped). `typecheck` plus `test:unit` is not enough.
- Server verification is `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`.
- No route, query param, response model or route docstring changes, so `openapi.json` is not regenerated. If a task finds it must change one, stop and report.
- Ports: e2e on `E2E_PORT` 8975 or a free one, never 8974.

## Review Focus

1. **Astral-heavy tag text on the server.** CPython matches an explicit class with astral ranges about 40x slower than `\w`: about 220 ms for one 1M-character tag of astral letters, measured. That is still linear, but backend perf may flag `refs.extract` timings. Task 5 records this; Task 7 runs perf and reads the result.
2. **Interleaved undo/redo with a refused replay.** A second undo or redo queued behind the refused one also moves entries between the stacks. Task 4's rule identifies fresh records by identity against both of `taken`'s stacks, so a later take of an old entry never counts as a record. Task 4 has a test for an interleaved second undo.
3. **Duplicate and absent ids in the replica's IN-lists.** `json_each` binds the array as given. The tests in Task 2 put real uids among 40,000 absent ones and repeat one uid.
4. **A stopped turn whose interrupted write never reports a result.** Its id stays in `_running_writes` until the next turn's `TurnDone`, so that turn's cards are over-stamped. That is conservative, and Task 6 pins that it ends there.
5. **A browser whose Unicode tables are older than the server's.** The old web class used the runtime's `\p{L}`, so iPad Safari could miss letters the server has. The generated table removes that dependency. Task 5's `ref_grammar.json` case runs on both sides.

---

### Task 1: pkm-0zi8 — pin linear macro scanning (no longer reproduces)

**Model:** sonnet

**Finding:** Fixed on main by 389380c0, which replaced the per-opener walk in `scanMacro` with one `braceCloses` stack pass. Measured on this worktree, `tokenizeBlock` is linear: 1M `{` takes 240 ms; `{{` ×500k, `{{query` ×140k, `{{[[query]]` ×90k, `{{pdf: ` ×140k and `{{query: {` ×100k each take under 80 ms. The remaining `prefix.exec(text.slice(i))` is not a copy, because V8 and JSC both make a substring an O(1) slice, so the bean's sticky-regex rewrite buys nothing. Pin the shapes 389380c0's tests do not cover, then complete the bean.

**Files:**
- Test: `web/src/grammar/tokenize.test.ts` (inside `describe("tokenizeBlock on long runs of math and macro openers")`)
- Bean: `.beans/pkm-0zi8--web-tokenizer-scanmacro-is-quadratic-on-unclosed-p.md`

- [ ] **Step 1: Add the pinning tests**

```ts
it("renders a block of unclosed `{` at the length cap in linear time", () => {
  const text = "{".repeat(MAX_BLOCK_TEXT_CHARS);
  const started = performance.now();
  const segs = tokenizeBlock(text);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(segs).toEqual([{ kind: "text", text }]);
}, 60_000);

it("renders unclosed `{{[[query]]` ×90,909 in linear time", () => {
  const text = "{{[[query]]".repeat(90_909);
  const started = performance.now();
  const segs = tokenizeBlock(text);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(segs).toEqual([{ kind: "text", text }]);
}, 60_000);
```

Import `MAX_BLOCK_TEXT_CHARS` from `./textLimits`. If either output assertion fails because the tokenizer splits the text into more than one segment, assert `segs.map((s) => s.text ?? "").join("")` equals `text` instead, and say so in the commit.

- [ ] **Step 2: Show the tests have teeth**

In `scanMacro`, temporarily put back the pre-389380c0 balanced-brace walk to the end of the text (`git show 389380c0^:web/src/grammar/tokenize.ts`). Run `cd web && pnpm vitest run src/grammar/tokenize.test.ts -t "unclosed"`. Expect the `{{[[query]]` case to FAIL on time, then revert the mutant. Plain `{` never matched a prefix even before 389380c0, so that case pins the brace-pass allocation only. Expect it to pass under the mutant.

- [ ] **Step 3: Run the file**

Run: `cd web && pnpm vitest run src/grammar/tokenize.test.ts`. Expected: PASS.

- [ ] **Step 4: Commit**

In the bean body, add a line saying it was fixed by 389380c0 and is pinned by these tests. `git add web/src/grammar/tokenize.test.ts .beans/pkm-0zi8--*.md`, then commit `test(grammar): pin linear tokenizing of unclosed macro prefixes`.

---

### Task 2: pkm-pvb6 — replica IN-lists past SQLite's variable limit (reproduces)

**Model:** opus

**Finding:** It reproduces. In the wasm build `blockRefCounts`, `fetchAncestors` and `resolveRefUids` in `web/src/replica/localApi/tree.ts` throw `SQLITE_ERROR: too many SQL variables` at 32,767 ids, while 32,766 pass. So the offline `pagePayload` and `journalPayload` fail on a page of more than 32,766 blocks, and backlink breadcrumbs (`fetchAncestors` over backlink rows) fail on more than 32,766 referring blocks.

**Decision:** bind each id set as one JSON array, `IN (SELECT value FROM json_each(?))`, instead of porting `chunk_ids`. The replica already uses this form for unbounded sets (`replayLog.ts`, `rewind.ts`). It needs one variable whatever the size, keeps one statement per read so perf's statement counts do not move, and cannot repeat the server's cross-chunk breadcrumb bug. Convert the bounded `backlinks` `pageIds` list in `pages.ts` too, so no replica statement binds one variable per id.

**Files:**
- Modify: `web/src/replica/localApi/tree.ts` (`resolveRefUids`, `blockRefCounts`, `fetchAncestors`)
- Modify: `web/src/replica/localApi/pages.ts` (`backlinks`)
- Test: `web/src/replica/localApi/tree.test.ts`
- Bean: `.beans/pkm-pvb6--*.md`

- [ ] **Step 1: Write the failing tests** in `tree.test.ts`, in a new `describe("id sets past SQLite's variable limit")`. Reuse `openTestDb`, `insertPage` and `seedLinearChain`.

```ts
// The wasm build refuses a statement binding more than 32,766 variables.
const absent = (n: number) =>
  Array.from({ length: n }, (_, i) => uidOf(`tuid-none${i}`));

test("blockRefCounts counts a target among 40,000 uids", async () => {
  t = await openTestDb();
  // seed: page 1, blocks tuid-src and tuid-tgt, one block_refs row
  // tuid-src -> tuid-tgt (columns per baseSchema.gen.ts)
  const uids = [...absent(40_000), uidOf("tuid-tgt"), uidOf("tuid-tgt")];
  expect(blockRefCounts(t.db, uids)).toEqual({ "tuid-tgt": 1 });
});

test("fetchAncestors trails a start among 40,000 uids", async () => {
  t = await openTestDb();
  const deep = seedLinearChain("big", 3);
  const trails = fetchAncestors(t.db, [...absent(40_000), deep]);
  expect(trails.get(deep)).toEqual(
    ["big text 0", "big text 1", "big text 2"]);
  expect(trails.size).toBe(1);
});

test("resolveRefUids resolves a uid among 40,000", async () => {
  t = await openTestDb();
  // seed: page "P" holding block tuid-r with text "r"
  expect(resolveRefUids(t.db, [...absent(40_000), uidOf("tuid-r")]))
    .toEqual({ "tuid-r": { text: "r", page_title: "P" } });
});

test("pagePayload serves a page of 33,000 blocks", async () => {
  t = await openTestDb();
  // seed page "Big" with 33,000 root blocks in one INSERT ... SELECT over a
  // recursive counter CTE (uids printf('tuid-b%05d', i))
  const payload = pagePayload(t.db, "Big", 0, 10, Date.now())!;
  expect(payload.blocks).toHaveLength(33_000);
  expect(payload.block_ref_counts).toEqual({});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/replica/localApi/tree.test.ts -t "variable limit"`. Expected: four FAILs with `too many SQL variables`.

- [ ] **Step 3: Rewrite the four statements**

Each `IN (${marks})` becomes `IN (SELECT value FROM json_each(?))`, bound to `JSON.stringify(ids)`; `backlinks` binds `[pageId, JSON.stringify(pageIds)]`. Delete the `marks` builders. Keep the early `return` on an empty list. Add one sentence to the comment on `blockRefCounts` saying why the array is bound whole: SQLite refuses a statement past its variable limit, and a page's uids are unbounded.

- [ ] **Step 4: Run the replica tests**

Run: `cd web && pnpm vitest run src/replica`. Expected: PASS, including the existing `fetchAncestors` `vmSteps` bounds.

- [ ] **Step 5: Commit**

`git add web/src/replica/localApi/tree.ts web/src/replica/localApi/pages.ts web/src/replica/localApi/tree.test.ts .beans/pkm-pvb6--*.md`, then commit `fix(replica): bind unbounded id sets as one JSON array`.

---

### Task 3: pkm-hrzs — a page with rows past the depth cap stays editable

**Model:** sonnet

**Finding:** Still open. `useOutline.depth.test.tsx` covers only trees at or under the cap, and nothing at the hook level shows that rows already past 100 levels leave the rest of the page editable.

**Files:**
- Test: `web/src/outline/useOutline.depth.test.tsx`
- Bean: `.beans/pkm-hrzs--*.md`

- [ ] **Step 1: Make `setup` take the initial tree**

Change it to `function setup(sync: SyncFake, initial: BlockNode[] = deepTree())`, which passes `initial` to `Harness`.

- [ ] **Step 2: Add the tests** in `describe("a page holding rows past the cap")`

```ts
/** A legacy chain L1 > ... > L120, then shallow roots s1 and s2. */
function legacyTree(): BlockNode[] {
  let node = block("tuid-L120", "L120");
  for (let level = 119; level >= 1; level--) {
    node = block(`tuid-L${level}`, `L${level}`, { children: [node] });
  }
  return [
    node,
    block("tuid-s1", "s1", { order_idx: orderIdxOf(1) }),
    block("tuid-s2", "s2", { order_idx: orderIdxOf(2) }),
  ];
}

it("an indent at a shallow level applies", () => {
  const sync = makeSync();
  const outline = setup(sync, legacyTree());
  act(() => outline().handlers.onIndent(uidOf("tuid-s2")));
  expect(sync.sent).toHaveLength(1);
  expect(parentOf(outline(), "tuid-s2")).toBe("tuid-s1");
  expect(outline().editNotice).toBeNull();
  // the undo is judged by the blocks it places, too
  act(() => { performUndo(sync); });
  expect(sync.sent).toHaveLength(2);
  expect(parentOf(outline(), "tuid-s2")).toBeNull();
  expect(outline().editNotice).toBeNull();
});

it("a subtree move at a shallow level applies", () => {
  // onMoveSubtreeUp(tuid-s2): one move sent, notice null
});

it("a paste at a shallow level applies", () => {
  // onPasteOutline(uidOf("tuid-s1"), 2, 2, "a\n\tb"): one batch sent whose
  // ops are ["update_text", "create"], notice null
});

it("the deep rows' text stays editable", () => {
  // onFocusBlock, onDraftStart(L120, "L120"),
  // onDraftChange(L120, "deep edit"), onFlushDraft:
  // sync.sent is [[{ op: "update_text", uid: "tuid-L120", ... }]],
  // findNode(..., L120).text is "deep edit", notice null
});
```

- [ ] **Step 3: Run them**

Run: `cd web && pnpm vitest run src/outline/useOutline.depth.test.tsx`. Expected: PASS.

- [ ] **Step 4: Show they catch a whole-page judge**

Temporarily replace the final loop of `findDepthViolation` in `web/src/outline/depthCap.ts` with this mutant, which judges the page's deepest row:

```ts
const reached = walk(after, 1);
for (const op of ops) {
  if ((op.op === "create" || op.op === "move") && reached > max) return op.uid;
}
return null;
```

Re-run the file. Expected: the indent, subtree move and paste tests FAIL, and the text test passes. Revert the mutant and record the result in the commit message.

- [ ] **Step 5: Commit**

`git add web/src/outline/useOutline.depth.test.tsx .beans/pkm-hrzs--*.md`, then commit `test(outline): rows past the depth cap leave the rest of the page editable`.

---

### Task 4: pkm-pgod — a refused replay after a slow page read keeps history order (reproduces)

**Model:** opus

**Finding:** It reproduces by reading, and the bug is pinned as expected behaviour. `history.test.ts` "restoreEntry pushes back an entry a new record cleared from redo" asserts `{ undo: [e2, e1] }`, which puts the refused older undo on top of the newer record. `restoreEntry` cannot do better, because it does not know what the stacks held at the take.

The epoch guard has a second problem. `undoManager.dispatch` checks `epoch` before the page read but not after it, so a reset during the read still raises a notice, still navigates, and ships an applicable write. Only the restore is guarded. `resetHistory` is a test seam, so the harm is limited to test isolation.

**Rule:** a refused replay is restored as though it had been refused at the take.
- A refused undo goes back below every entry recorded since the take.
- A refused redo whose take was followed by a record is dropped, because that record cleared the redo stack. It is not left on undo either, since it never applied.

**Files:**
- Modify: `web/src/outline/history.ts` (`restoreEntry`)
- Modify: `web/src/outline/undoManager.ts` (`performUndo`, `performRedo`, `dispatch`, `dispatchUnmounted`)
- Test: `web/src/outline/history.test.ts`, `web/src/outline/undoManager.test.ts`
- Bean: `.beans/pkm-pgod--*.md`

**Interfaces:**
- Produces: `restoreEntry(state: HistoryState, entry: HistoryEntry, kind: "undo" | "redo", taken: HistoryState): HistoryState`, where `taken` is the `state` the matching `takeUndo` or `takeRedo` returned.

- [ ] **Step 1: Write the failing undoManager tests** (append after the depth-cap tests; reuse `recordMove`, `indented`, `outdented`, `deepen`, `entry`, `defer`, `hooksFor`)

```ts
const OTHER = canonicalTitleOf("Other Page");

it("a refused undo goes back below an edit recorded during its read",
   async () => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  performUndo(sync);
  recordHistory({ ...entry(), pageTitle: OTHER });
  gate.resolve(deepen(outdented()));
  await historyIdle();
  expect(sync.sent).toEqual([]);
  setHistoryPageLoader(async () => outdented());
  performUndo(sync);
  await historyIdle();
  performUndo(sync);
  await historyIdle();
  expect(sync.tickets.map((t) => t.scope))
    .toEqual([["page", OTHER], ["page", PAGE]]);
});

it("a refused redo is dropped when an edit was recorded during its read",
   async () => {
  const sync = makeSync();
  recordMove(outdented(), indentOps());
  setHistoryPageLoader(async () => indented());
  performUndo(sync);
  await historyIdle();
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  performRedo(sync);
  recordHistory({ ...entry(), pageTitle: OTHER });
  gate.resolve(deepen(outdented()));
  await historyIdle();
  expect(sync.sent).toHaveLength(1);
  expect(performRedo(sync)).toBe(false);
  setHistoryPageLoader(async () => []);
  expect(performUndo(sync)).toBe(true);
  await historyIdle();
  expect(sync.tickets.at(-1)!.scope).toEqual(["page", OTHER]);
  expect(performUndo(sync)).toBe(false);
});

it.each([
  ["refused", () => deepen(outdented())],
  ["applicable", () => outdented()],
])("a reset during a pending read of a %s undo leaves no trace",
   async (_name, tree) => {
  const sync = makeSync();
  recordMove(indented(), outdentOps());
  const gate = defer<BlockNode[]>();
  setHistoryPageLoader(() => gate.promise);
  const paths: string[] = [];
  const clear = setHistoryNavigator((p) => paths.push(p));
  performUndo(sync);
  resetHistory();
  gate.resolve(tree());
  await new Promise((r) => setTimeout(r, 0));
  expect(sync.sent).toEqual([]);
  expect(paths).toEqual([]);
  const h = hooksFor();
  expect(h.notices).toEqual([]);
  h.unregister();
  expect(performUndo(sync)).toBe(false);
  clear();
});
```

- [ ] **Step 2: Rewrite and add history.test.ts cases**

- "restoreEntry after takeUndo/takeRedo gives back the pre-take state": pass `taken.state` as the fourth argument.
- "restoreEntry removes the entry by identity": pass `s` as `taken`.
- Rename "restoreEntry pushes back an entry a new record cleared from redo" to "a refused undo goes back below an entry recorded since its take". It passes `taken` from the `takeUndo` and expects `{ undo: [e1, e2], redo: [] }`.
- "a refused redo is dropped when an entry was recorded since its take": record e1, takeUndo, takeRedo (`taken`), record e2, then `restoreEntry(state, e1, "redo", taken.state)` equals `{ undo: [e2], redo: [] }`.
- "a later take of an old entry is not a record" (Review Focus 2): record e1 and e2, then take e2 (`taken`) and take e1. `restoreEntry(state, e2, "undo", taken.state)` equals `{ undo: [e2], redo: [e1] }`.
- The upload case: pass `taken.state`; its expectation is unchanged.

- [ ] **Step 3: Run both files to verify the new cases fail**

Run: `cd web && pnpm vitest run src/outline/history.test.ts src/outline/undoManager.test.ts`. Expected: the two order tests and both reset cases FAIL, and so do the rewritten history cases (an extra argument is ignored at run time, so the old order shows).

- [ ] **Step 4: Implement `restoreEntry` with `taken`**

`known` is the set of entries in `taken.undo` or `taken.redo`, by identity. Any entry of `state.undo` or `state.redo` outside `known` was recorded since the take.
- For `"undo"`: insert `entry` into `state.undo` just below the lowest fresh entry, or on top if there is none. Apply `.slice(-HISTORY_CAP)`, and remove `entry` from `state.redo` as now.
- For `"redo"`: if any fresh entry exists, return `{ undo: without(state.undo), redo: state.redo }`. Otherwise keep the current behaviour.

Rewrite the doc comment to state the "as though refused at the take" rule.

- [ ] **Step 5: Wire `taken` and the post-read epoch check in `undoManager.ts`**

- `performUndo` and `performRedo` keep the take's `state` and pass it to `restoreEntry`.
- `dispatchUnmounted` gains a parameter `stale: () => boolean`, called right after `await loadPage(title)` resolves or throws. When it is true, it returns `{ delivered: failed(new Error("history reset")) }` without refusing, enqueueing or settling.
- `dispatch` passes `() => mine !== epoch` and calls `onRefused` directly, dropping the `refused` wrapper, which the new check makes unreachable.
- Update the header comment's refusal paragraph: a refused entry goes back as though refused at the keypress.

- [ ] **Step 6: Run the outline tests**

Run: `cd web && pnpm vitest run src/outline`. Expected: PASS.

- [ ] **Step 7: Commit**

`git add web/src/outline/history.ts web/src/outline/history.test.ts web/src/outline/undoManager.ts web/src/outline/undoManager.test.ts .beans/pkm-pgod--*.md`, then commit `fix(undo): a refused replay goes back as though refused at the keypress`.

---

### Task 5: pkm-9y7y — one generated tag-name class for server and web (reproduces)

**Model:** opus

**Finding:** It reproduces, and the gap is wider than the bean says. The server runs CPython 3.12.10, whose `unicodedata` is Unicode 15.0. Node 26's ICU is Unicode 17.0. Over all code points, Python's `[\w/.\-]` and the web's `[\p{L}\p{N}_./\-]` differ on 9,661 code points, all accepted by the web only; there are none the other way. So the classes agree in kind and differ only by Unicode version. A browser with older tables than 15.0 would err the other way. `linkReference.ts`'s `ALNUM` has no server mirror and is out of scope.

**Decision:** freeze the class as the code-point ranges of CPython 3.12's `\w` (748 ranges, Unicode 15.0). This keeps every tag the server recognises today, `#café` included, and drops only web-only tags. The table is committed as a generated Python constants module that `refs.py` compiles. A dump script also writes it into a generated TS string that `scan.ts` compiles. A Python or browser bump then changes nothing.

**Files:**
- Create: `server/src/pkm/tag_chars_dump.py` (Imperative Shell; same shape as `title_whitespace_dump.py`)
- Create (generated): `server/src/pkm/contracts/tag_chars.py` (`# pattern: Functional Core`, constants only)
- Create (generated): `web/src/grammar/tagChars.gen.ts`
- Modify: `server/src/pkm/refs.py` (`_TAG_NAME`, plus the comment above it)
- Modify: `web/src/grammar/scan.ts` (`TAG_CHARS_RE`, plus the comment above it)
- Modify: `web/tooling/fcis-exemptions.json` (add `src/grammar/tagChars.gen.ts`)
- Modify: `shared/fixtures/ref_grammar.json` (new case), `server/src/pkm/refs_parity_dump.py` (`CASES`), regenerated `shared/fixtures/refs_parity.json`
- Test: `server/tests/test_tag_chars_artifact.py` (new), `server/tests/test_refs.py`
- Bean: `.beans/pkm-9y7y--*.md`

**Interfaces:**
- `pkm.contracts.tag_chars`: `TAG_CHARS_UNICODE_VERSION: str = "15.0.0"` and `TAG_WORD_RANGES: tuple[tuple[int, int], ...]` (inclusive, ascending, disjoint, no surrogates).
- `pkm.tag_chars_dump`:
  - `word_ranges() -> list[tuple[int, int]]` gives the running interpreter's `\w` as ranges.
  - `python_module(ranges, unicode_version: str) -> str` is the text of `contracts/tag_chars.py`, six ranges a line as `(0x0041, 0x005A),`.
  - `ts_module(ranges) -> str` is an ASCII header plus `export const TAG_WORD_CLASS = "...";`, each bound written `\\u{hex}` so that the RegExp receives `\u{hex}`.
  - `main(argv: list[str] | None = None) -> int`: `--table` prints `python_module(word_ranges(), unicodedata.unidata_version)`, and no flag prints `ts_module(TAG_WORD_RANGES)`.
- `web/src/grammar/tagChars.gen.ts`: `export const TAG_WORD_CLASS: string`.

- [ ] **Step 1: Write the failing grammar cases**

Add to `shared/fixtures/ref_grammar.json`, after "unicode hashtags":

```json
{"name": "a letter newer than the shared tag table ends a hashtag",
 "text": "see #café, #a\uA7CBb and #\uA7CC",
 "refs": [{"title": "café", "kind": "tag"}, {"title": "a", "kind": "tag"}],
 "block_refs": [], "embeds": 0}
```

U+A7CB and U+A7CC are Unicode 16 letters outside CPython 3.12's `\w` (checked). Keep them as JSON `\u` escapes so no editor can swap them. U+A7D0 would not do: it is Unicode 14 and already a server tag letter.

Add to `test_refs.py`:

```python
def test_bare_tag_title_follows_the_shared_table():
    assert is_bare_tag_title("caf\u00e9")
    assert not is_bare_tag_title("a\ua7cb")
```

Add `"#caf\u00e9 and #a\ua7cbb"` to `refs_parity_dump.CASES`.

- [ ] **Step 2: Run to verify the web side fails**

Run: `cd web && pnpm vitest run src/grammar/refs.test.ts`. Expected: the new case FAILS, because the web reads `aꟋb`. The server cases pass, which pins the server's current behaviour.

- [ ] **Step 3: Write `tag_chars_dump.py` and generate both artifacts**

```bash
cd server
uv run python -m pkm.tag_chars_dump --table > src/pkm/contracts/tag_chars.py
uv run python -m pkm.tag_chars_dump > ../web/src/grammar/tagChars.gen.ts
```

`contracts/tag_chars.py` must say, in its own header, the command that generated it and that it must not be hand-edited.

- [ ] **Step 4: Write `server/tests/test_tag_chars_artifact.py`**

- The committed `tagChars.gen.ts` equals `ts_module(TAG_WORD_RANGES)`.
- The committed `contracts/tag_chars.py` equals `python_module(word_ranges(), TAG_CHARS_UNICODE_VERSION)`. Run this only when `unicodedata.unidata_version == TAG_CHARS_UNICODE_VERSION`, and `pytest.skip` with the reason otherwise.
- `ts_module` output is ASCII, and its escapes round-trip to the ranges.
- The ranges are ascending, disjoint and surrogate-free, and they contain `ord("_")`, `ord("é")` and `ord("日")` but not `0xA7CB`.
- `main([])` prints the TS module and `main(["--table"])` prints the Python module (use `capsys`).

- [ ] **Step 5: Compile both sides from the table**

- `refs.py`: `_TAG_NAME = rf"[{_TAG_WORD_CLASS}/.\-]+"`, where `_TAG_WORD_CLASS` joins `TAG_WORD_RANGES` as `\U{lo:08x}-\U{hi:08x}`, or a single `\U{lo:08x}` when `lo == hi`.
- `scan.ts`: `const TAG_CHARS_RE = new RegExp(`[${TAG_WORD_CLASS}./\\-]+`, "uy");`.
- Replace the old comments on both sides with one rule: the class is one frozen table, because each runtime's Unicode tables differ and the two sides would disagree on a block's tags.

- [ ] **Step 6: Regenerate the parity fixture and run both sides**

```bash
cd server && uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json
uv run pytest -q tests/test_refs.py tests/test_refs_parity_fixture.py tests/test_tag_chars_artifact.py
cd ../web && pnpm vitest run src/grammar src/replica/refs.test.ts
```

Expected: PASS. Then `git diff --no-ext-diff --stat shared/fixtures/refs_parity.json` should show only the added case.

- [ ] **Step 7: Commit**

`git add server/src/pkm/tag_chars_dump.py server/src/pkm/contracts/tag_chars.py server/src/pkm/refs.py server/src/pkm/refs_parity_dump.py server/tests/test_tag_chars_artifact.py server/tests/test_refs.py web/src/grammar/tagChars.gen.ts web/src/grammar/scan.ts web/tooling/fcis-exemptions.json shared/fixtures/ref_grammar.json shared/fixtures/refs_parity.json .beans/pkm-9y7y--*.md`, then commit `fix(grammar): server and web read tag names from one generated table`.

---

### Task 6: pkm-qotb — a stopped turn's running write stamps the next turn's cards (reproduces)

**Model:** opus

**Finding:** It reproduces, and it is two-sided. The bean's `send()` is the server's `ClaudeConversation.send` in `server/src/pkm/assistant/claude_engine.py`, which runs `self._running_writes.clear()` at turn start. The web hides the marker even with a stamp: `useAssistant.send` zeroes `allowedInTurn` at turn start, and `ConfirmCard` shows `.assistant-confirm-stale` only when `allowedAhead > 0`.

**Rule:** both sides forget a turn's writes when the turn finishes, not when the next one starts.
- Server: a `TurnDone` clears `_running_writes`; a stopped or errored turn's ids stay until their tool result arrives in a later pump or that turn's `TurnDone`.
- Web: a `turn_done` event zeroes `allowedInTurn`, and so does adopting a newly created conversation. `send()` no longer does.
- The stale-card copy drops "in this turn", since the count can now include a stopped turn's Allows: "You allowed 1 earlier card, and its write may have landed after this card was read; the current text it shows may have changed."

**Files:**
- Modify: `server/src/pkm/assistant/claude_engine.py` (`send`)
- Test: `server/tests/test_claude_engine.py`
- Modify: `web/src/assistant/useAssistant.ts` (`send`, `applyEvent`'s `turn_done` case, `runTurn` after `conversationId.current = created.id`)
- Modify: `web/src/assistant/AssistantPanel.tsx` (the stale copy)
- Test: `web/src/assistant/useAssistant.test.tsx`, `web/src/assistant/AssistantPanel.test.tsx`
- Bean: `.beans/pkm-qotb--*.md`

- [ ] **Step 1: Write the failing server test** next to `test_the_last_turns_writes_are_not_in_flight`

```python
def test_a_stopped_turns_running_write_stamps_the_next_turns_cards(
        tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        one = conv.send("one")
        task = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
        card = await asyncio.wait_for(anext(one), timeout=5)
        assert isinstance(card, ConfirmRequest)
        conv.resolve_confirm(card.confirm_id, True)
        await asyncio.wait_for(task, timeout=5)
        await one.aclose()  # Stop: t1 allowed, no result yet

        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("two"), seen))

        async def card_for(uid: str, tool_use_id: str):
            t = asyncio.create_task(conv.can_use_tool(
                _UPDATE, {"uid": uid, "text": "t"}, _ctx(tool_use_id)))
            c = await _next_of(seen, ConfirmRequest)
            conv.resolve_confirm(c.confirm_id, False)
            await asyncio.wait_for(t, timeout=5)
            return c

        stamped = await card_for("BBBBBBBB", "t2")
        client.feed(UserMessage(content=[
            ToolResultBlock(tool_use_id="t1", content="ok")]))
        await _next_of(seen, ToolFinished)
        clear = await card_for("CCCCCCCC", "t3")
        client.feed(make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return stamped, clear

    stamped, clear = asyncio.run(scenario())
    assert stamped.preview.writes_in_flight is True
    assert clear.preview.writes_in_flight is False
```

Add a second test (Review Focus 4): a stopped turn's t1 never reports a result. The next turn's first card is stamped, that turn ends with `make_result()`, and the third turn's first card is not stamped. Abandon turn one as above (`anext`, then `aclose`), the pattern `test_send_interrupts_harness_when_consumer_drops_mid_confirm` uses.

- [ ] **Step 2: Write the failing web tests**

- In `useAssistant.test.tsx`, "a new turn counts no Allow from the last": turn one's stream emits `{ type: "turn_done", usage: null }` before it returns. The expectation stays 0.
- New "a stopped turn's Allows count for the next turn's cards": turn one emits `c1` and hangs. Call `respondConfirm(true)`, then `latest.stop()`, then `send("two")`, whose stream emits `c2`. Expect `pendingConfirm.confirmId` `c2` with `allowedAhead` 1.
- New "a new conversation counts no Allow from the old one": as above, but call `newChat()` before `send("two")`. Expect 0.
- In `AssistantPanel.test.tsx`, update the two copy expectations to the strings in the Rule above.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd server && uv run pytest -q tests/test_claude_engine.py -k "stopped_turn"` and `cd web && pnpm vitest run src/assistant`. Expected: the new server tests, the stopped-turn web test and the two copy tests FAIL.

- [ ] **Step 4: Implement**

- Server `send()`: delete the turn-start `clear()` and its comment. On a `TurnDone` event, clear `_running_writes` before yielding it, with a comment that every write of a finished turn has its result. `_pump`'s `difference_update` already drops a stopped turn's id when its result arrives later.
- Web: move `allowedInTurn.current = 0` from `send` into the `turn_done` case of `applyEvent`, and also run it right after `conversationId.current = created.id` in `runTurn`. Update the comment on `allowedInTurn` to "the Allows posted since the last turn that finished". Change the copy in `AssistantPanel.tsx`.

- [ ] **Step 5: Run both suites' assistant tests**

Run: `cd server && uv run pytest -q tests/test_claude_engine.py tests/test_fake_engine.py` and `cd web && pnpm vitest run src/assistant`. Expected: PASS, including `test_the_last_turns_writes_are_not_in_flight`.

- [ ] **Step 6: Commit**

`git add server/src/pkm/assistant/claude_engine.py server/tests/test_claude_engine.py web/src/assistant/useAssistant.ts web/src/assistant/useAssistant.test.tsx web/src/assistant/AssistantPanel.tsx web/src/assistant/AssistantPanel.test.tsx .beans/pkm-qotb--*.md`, then commit `fix(assistant): a stopped turn's running write still stamps the next turn's cards`.

---

### Task 7: Docs, gates and completion

**Model:** opus

**Files:**
- Modify: `docs/troubleshooting.md`, `docs/architecture/backend.md`, `docs/architecture/frontend-editor.md`, `docs/architecture/assistant.md`
- Beans: all six

- [ ] **Step 1: Invoke the `architecture-docs` skill**, then make these edits. Verify each claim against the code, not against this plan.
  - `backend.md § Database`: one sentence after the `chunk_ids` rule. The replica's shim (`replica/localApi/`) binds such a set as one JSON array (`json_each`), because the wasm build has the same limit.
  - `backend.md § Ref grammar`: add a table row. A `#tag` name is `_/.-` plus `TAG_WORD_RANGES`; Python is `_TAG_NAME`, TS is `TAG_CHARS_RE`; it is pinned by `ref_grammar.json` and `test_tag_chars_artifact.py`. Widen the paragraph on Unicode classes to say why the tag class is a frozen table rather than ASCII (`#café`).
  - `backend.md § Generated artifacts and parity fixtures`: add rows for `contracts/tag_chars.py` (`uv run python -m pkm.tag_chars_dump --table > src/pkm/contracts/tag_chars.py`, regenerated only on a deliberate Unicode move) and `web/src/grammar/tagChars.gen.ts` (`uv run python -m pkm.tag_chars_dump > ../web/src/grammar/tagChars.gen.ts`), both guarded by `test_tag_chars_artifact.py`.
  - `frontend-editor.md`, in the paragraph ending "a refused undo or redo keeps its entry for a retry": as though refused at the keypress, so an undo goes back below edits recorded during its page read, and a redo whose take a newer edit followed is dropped.
  - `assistant.md`, in the stamp table's `_pump` and `useAssistant` rows: a turn's writes are forgotten when the turn finishes. A stopped turn's running writes still stamp the next turn's cards, and `allowedAhead` counts Allows since the last finished turn.
  - `troubleshooting.md` rows (Symptom | Cause | Where | Ref):
    - Sync and offline, "A replica or view that disagrees with the server": the offline page, journal or backlinks read fails with `too many SQL variables` on a page of more than 32,766 blocks → pkm-pvb6.
    - Editor: after a slow undo or redo on an unmounted page near the depth cap, the next undo replays an older edit first, or a redo replays over a newer edit → pkm-pgod.
    - Backend, "Titles and the ref grammar": a `#tag` with a Unicode-16 letter is a tag in the browser but not on the server → pkm-9y7y.
    - Assistant: after Stop with an allowed write still running, the next turn's card shows no "may have changed" marker → pkm-qotb.
    - No row for pkm-0zi8 (fixed and recorded by 389380c0) or pkm-hrzs (a test).

- [ ] **Step 2: Run the full gates**

```bash
set -o pipefail
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
cd ../web && pnpm verify
cd .. && PYTHONPATH=server/tooling python3 -m commentlint.run --all
```

Expected: all exit 0.

- [ ] **Step 3: Run the property gate**

Run: `proptest/check.sh`. It picks server and web from the diff; the web sync, ops and outline suites matter for Tasks 2 and 4. Expected: PASS. Handle a failure per AGENTS.md: a product bug gets a unit test from the shrunk example, a wrong property is fixed in `props/` with the reason, and a flaky one gets a bean.

- [ ] **Step 4: Run perf on a quiet machine**

Run `perf/check.sh backend`, then `perf/check.sh frontend`. Expected: no regression. A backend timing flag on `refs` work is Review Focus 1: read it, then bring the table to Arthur, never `--allow-busy`. Commit any baseline file the check rewrites.

- [ ] **Step 5: Mark the beans complete and commit**

Tick every remaining checkbox and set `status: completed` in the six bean files. Commit the docs and beans: `docs: offline id sets, undo restore order, tag table, stamp lifetime; complete six beans`. The message says what was added and what was corrected.
