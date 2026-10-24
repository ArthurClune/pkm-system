# Write-Time Text Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No block's text is ever written longer than 1,000,000 code points
or with `[[` nested deeper than 32 levels: every server write path refuses
it, the importer refuses an export holding one, and the web refuses the edit
with a notice before it can queue an op the server would refuse.

**Architecture:** One pure judge per side (`pkm/text_limits.py`,
`web/src/grammar/textLimits.ts`) over one nesting measure per side
(`refs.link_nesting_depth`, `scan.linkNestingDepth`), the two pinned equal by
a generated parity fixture. The server calls the judge in `apply_batch`
before anything else reads the text, in the rewrite paths it owns (rename,
merge, title migration, page delete) and in the importer. The web calls it
at every place an edit is born (draft change, paste, outline command,
undo/redo, link-unlinked) and, as the mirror of the server guard, in the
replica's `enqueueBatch`.

**Tech Stack:** Python 3.12 / FastAPI / SQLite, hypothesis (server); React +
TS, vitest, fast-check, Playwright (web).

**Spec:** `docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`,
rows pkm-gc3n and pkm-bppf (binding). Beans: pkm-gc3n, pkm-bppf; pkm-eovh is
re-judged after this lands and is not in scope.

## Global Constraints

Spec values, verbatim:

- pkm-gc3n: "1,000,000 Unicode code points per block (Python `len`; web
  `[...text].length`). Refused on every write path: ops, importer, CLI, MCP,
  assistant. A paste in the editor past the cap shows a notice and does not
  paste; nothing is truncated. An import holding a longer block is refused,
  naming the page. No prod row is over the cap (largest 258,277 on
  2026-10-24)"
- pkm-bppf: "A write-time limit of 32 levels of nested `[[`, refused like the
  block cap, imports included (refused, naming the page). This replaces
  rewriting the web tokenizer. Prod's deepest nesting is 2"

Decisions this plan fixes (the report beside it gives the reasons):

- Boundaries: 1,000,000 code points is accepted, 1,000,001 refused; depth 32
  is accepted, 33 refused.
- **Nesting depth** is the depth of the `[[...]]` run tree both scanners
  already build: strip code exactly as `strip_code` / `scanCode` do, pair
  aligned `[[` and `]]` with the stack `bracket_spans` / `matchBracketPairs`
  use (unclosed `[[` and stray `]]` are plain text and do not count), drop a
  pair whose title as written holds a backtick (`holds_backtick`), then the
  depth is the longest chain of pairs each strictly inside the previous; 0
  when there is none. `#[[` counts like `[[`. Brackets inside inline code or
  a closed fence do not count; an unclosed fence hides nothing. Iterative,
  O(n log n) at worst (the sort of pairs), no recursion.
- Judged order: length first, then nesting, so the nesting scan never reads
  more than 1,000,000 code points. Fast path for nesting: a text holding at
  most 32 non-overlapping `[[` (`str.count`, an `indexOf` loop) cannot
  nest deeper than 32.
- What is judged: the text a write would store. Any text over a limit is
  refused, including an edit to a legacy row that leaves it over (spec:
  "refused on write"). Reads, moves and deletes of a legacy row are never
  judged. An edit that brings a legacy row under both limits is accepted.
- Refusal strings, exactly (`<n>` is the measured value):
  - describe, length: `text of <n> characters is over the limit of 1000000`
  - describe, nesting: `[[ nested <n> levels deep is over the limit of 32`
  - `/api/ops` 400: `{"index": <op index>, "reason": "block <uid>: <describe>"}`
  - importer: `error: import refused: block <uid> on <page title repr>: <describe>`, exit 2
  - rename / merge 422 detail: `rename refused: block <uid> on <page title repr>: <describe>`
  - title migration 409 detail: `title migration refused: block <uid> on <page title repr>: <describe>`
  - page delete: a 409 blocker (and delete-preview blocker) with reason `limit`
  - web notices: `A block can't be longer than 1,000,000 characters.` and
    `Links can't nest more than 32 levels deep.`
- The web never truncates: a refused edit leaves the draft and the tree as
  they were and sends nothing.
- The web tokenizer is not rewritten. A block whose tokens nest past 32
  (a legacy row) renders with no ref tokens rather than recursing.
- AGENTS.md: FCIS pattern header on every new runtime file; no bean ids,
  line numbers or plan pointers in code comments; comment lines at most 80
  columns; `git add` explicit paths only; commit messages end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and
  carry no session URL. Implementers run no `beans` commands.
- Any route, response model or route docstring change regenerates
  `web/src/api/openapi.json` and `types.d.ts` (backend.md § Generated
  artifacts and parity fixtures) in the same task.

## Review Focus

1. **Astral text near the cap.** 1,000,000 emoji is 2,000,000 UTF-16 units:
   the web must accept it (code points, not `.length`) and the server must
   too. Tests: parity fixture cases (Tasks 1, 2), `BlockInput` admit test
   (Task 6).
2. **Many links side by side.** A long note with hundreds of `[[x]]` misses
   the fast path; the full measure must say 1 and accept, and typing in it
   must stay usable. Tests: fixture `side_by_side` (Tasks 1, 2), the
   `useBlockDraft` keystroke test on a 250,000-char linked block (Task 6),
   perf gate (Task 11).
3. **Code that hides brackets, then stops hiding them.** A fence holding a
   40-deep nest is accepted; splitting the block inside the fence (Enter)
   exposes the nest in the first half. `run()` must refuse the split with
   the notice rather than ship a batch the server poisons. Test in Task 6.
4. **A legacy over-limit row** (inserted by SQL): server reads, move and
   delete work; an edit leaving it over is refused, an edit bringing it
   under is accepted; the web renders it without throwing. Tests in Tasks 3
   and 8.
5. **Server-made growth.** A page delete whose inlined `((ref))` copies push
   a block past a limit, and a rename whose longer title pushes a block past
   the cap, are refused with nothing changed. Tests in Task 4.

---

### Task 1: Server measure, judge and parity fixture (implementer: opus)

**Files:**
- Modify: `server/src/pkm/refs.py` (split pairing out of `bracket_spans`;
  add `link_nesting_depth`)
- Modify: `server/src/pkm/contracts/ops.py` (two constants beside
  `MAX_OUTLINE_DEPTH`)
- Create: `server/src/pkm/text_limits.py` (Functional Core)
- Create: `server/src/pkm/text_limits_parity_dump.py` (Imperative Shell,
  modelled on `refs_parity_dump.py`)
- Create: `shared/fixtures/text_limits_parity.json` (generated)
- Test: `server/tests/test_text_limits.py`,
  `server/tests/test_text_limits_parity_fixture.py`

**Interfaces:**
- Produces:
  - `pkm.contracts.ops.MAX_BLOCK_TEXT_CHARS: Final = 1_000_000`,
    `MAX_LINK_NESTING: Final = 32`, each with a comment saying why
    (export memory scales with the largest block; the web tokenizer recurses
    once per nested run) and that the parity fixture pins the web's copy.
  - `pkm.refs.link_nesting_depth(text: str) -> int`
  - `pkm.text_limits.TextLimitKind = Literal["length", "nesting"]`
  - `@dataclass(frozen=True) class TextLimitViolation: kind: TextLimitKind;
    measured: int; limit: int`
  - `pkm.text_limits.text_limit_violation(text: str) -> TextLimitViolation | None`
  - `pkm.text_limits.describe_text_limit(v: TextLimitViolation) -> str`
    (the describe strings in Global Constraints)
  - `pkm.text_limits_parity_dump.fixture() -> dict`, `CASES`,
    `generated_cases() -> list[str]`, `GENERATED_COUNT`, `SHAPES`,
    `shape_tally(texts) -> dict[str, int]`

- [ ] **Step 1: Red tests** in `server/tests/test_text_limits.py`:
  - `test_length_boundary`: `text_limit_violation("x" * 1_000_000) is None`;
    `"x" * 1_000_001` gives `TextLimitViolation("length", 1_000_001, 1_000_000)`.
  - `test_astral_counts_code_points`: `"\U0001F600" * 1_000_000` is None;
    one more is a length violation measuring 1_000_001.
  - `test_nesting_boundary`: with `nest(d) = "[[a//" * d + "x" + "]]" * d`,
    `nest(32)` is None, `nest(33)` gives `("nesting", 33, 32)`; the peeled
    shape `"[[" * 33 + "x" + "]]" * 33` and the tag shape
    `"#[[a//" * 33 + "x" + "]]" * 33` also measure 33.
  - `test_length_is_judged_before_nesting`: `nest(40) + "x" * 1_000_000`
    is a `length` violation.
  - `test_what_does_not_count`: depth 0 for `"[[" * 100`, for
    `"`" + "[[" * 40 + "x" + "]]" * 40 + "`"`, for
    `"```\n" + nest(40) + "\n```"`, for `"[[a`" * 40 + "x" + "]]" * 40`;
    depth 1 for `"]]" * 100 + "[[a]]"` and for `"[[x]] " * 500`; depth 40
    for `"```\n" + nest(40)` (unclosed fence hides nothing).
  - `test_deep_nest_is_linear_not_recursive`: `link_nesting_depth` of
    `"[[" * 200_000 + "x" + "]]" * 200_000` returns 200_000 without
    `RecursionError`.
  - `test_depth_matches_the_bracket_span_tree` (hypothesis, ordinary unit
    property, not `proptest`-marked): over texts drawn from the tokens
    `["[[", "]]", "[", "]", "`", "```", "\n", "#", "a", "a//", " "]`,
    `link_nesting_depth(t)` equals the height of
    `bracket_spans(strip_code(t), t)` computed with an explicit stack.
  - `test_fast_path_agrees`: same strategy; `text_limit_violation(t)` is a
    nesting violation exactly when `link_nesting_depth(t) > 32` (draw some
    texts with more than 32 openers: weight the `[[` token).
  - `test_describe_strings`: the two describe strings, exactly.
- [ ] **Step 2: Run** `cd server && uv run pytest -q tests/test_text_limits.py --no-cov`.
  Expected: FAIL (`ImportError: cannot import name 'link_nesting_depth'`).
- [ ] **Step 3: Implement.** In `refs.py`, move `bracket_spans`' pairing
  loop, backtick filter and sort into `_bracket_pairs(text: str, source:
  str) -> list[tuple[int, int]]` (open offset, close offset, sorted by open),
  used by `bracket_spans` unchanged in behaviour. `link_nesting_depth`
  is:

  ```python
  pairs = _bracket_pairs(strip_code(text), text)
  closes: list[int] = []   # close offsets of the pairs enclosing this one
  deepest = 0
  for open_, close in pairs:
      while closes and open_ >= closes[-1]:
          closes.pop()
      closes.append(close)
      deepest = max(deepest, len(closes))
  return deepest
  ```

  `text_limit_violation`: `len(text) > MAX_BLOCK_TEXT_CHARS` gives the
  length violation; else `text.count("[[") <= MAX_LINK_NESTING` gives None
  (comment why the count bounds the depth: every counted run opens with a
  distinct non-overlapping `[[`, and the greedy count is the most there can
  be); else measure.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also
  `uv run pytest -q tests/test_refs.py tests/test_bracket_walk_equivalence.py tests/test_legacy_deep_brackets.py --no-cov`:
  PASS (the refactor changes no behaviour).
- [ ] **Step 5: Parity dump, red test first.**
  `server/tests/test_text_limits_parity_fixture.py`, modelled on
  `test_refs_parity_fixture.py`:
  `test_committed_text_limits_fixture_is_current` (committed JSON equals
  `fixture()`), `test_generated_corpus_reaches_every_shape` (every name in
  `SHAPES` tallied at least 15 times over `generated_cases()`, no duplicate
  texts), `test_fixture_constants_match_the_contract`.
  Fixture shape (one definition both sides read):

  ```json
  {"max_block_text_chars": 1000000, "max_link_nesting": 32,
   "cases": [{"name": "...", "parts": [["x", 1000001]],
              "code_points": 1000001, "nesting_depth": 0,
              "violation": {"kind": "length", "measured": 1000001,
                            "limit": 1000000,
                            "describe": "text of 1000001 characters is over the limit of 1000000"}}],
   "generated": [{"text": "...", "nesting_depth": 3}]}
  ```

  A case's text is the concatenation of `unit * count` over `parts`, so a
  1,000,001-character case costs a few bytes. `CASES` holds every text
  named in Step 1 (as parts), plus a lone surrogate case
  `[["\ud800", 1], ["x", 999999]]` (accepted, 1,000,000 code points) and a
  multi-line 33-deep nest. `generated_cases()` draws `GENERATED_COUNT = 400`
  texts from the Step 1 token alphabet with `random.Random(<fixed seed>)`;
  `SHAPES` tallies at least: `deep` (depth >= 3), `code hides brackets`,
  `backtick-held run`, `unclosed opener`, `stray closer`, `triple bracket`.
- [ ] **Step 6: Generate and run.**
  `cd server && uv run python -m pkm.text_limits_parity_dump > ../shared/fixtures/text_limits_parity.json`
  then `uv run pytest -q tests/test_text_limits_parity_fixture.py --no-cov`.
  Expected: PASS.
- [ ] **Step 7: Gates for the task.** `uv run pyrefly check`,
  `uv run ruff check`. Expected: clean.
- [ ] **Step 8: Commit** `server/src/pkm/refs.py`,
  `server/src/pkm/contracts/ops.py`, `server/src/pkm/text_limits.py`,
  `server/src/pkm/text_limits_parity_dump.py`,
  `shared/fixtures/text_limits_parity.json`, the two test files:
  `server: text limit judge and nesting measure, with parity fixture`.

---

### Task 2: Web measure and judge, pinned by the fixture (implementer: opus)

**Files:**
- Modify: `web/src/grammar/scan.ts` (export `linkNestingDepth`; share the
  filtered pairing with `scanGrammar`)
- Create: `web/src/grammar/textLimits.ts` (Functional Core)
- Test: `web/src/grammar/textLimitsParity.test.ts`,
  `web/src/grammar/textLimits.test.ts`,
  `web/src/grammar/linkNesting.props.test.ts`

**Interfaces:**
- Consumes: `shared/fixtures/text_limits_parity.json` (Task 1).
- Produces (all in `textLimits.ts` unless noted):
  - `scan.ts`: `export function linkNestingDepth(text: string): number`
  - `MAX_BLOCK_TEXT_CHARS = 1_000_000`, `MAX_LINK_NESTING = 32`
  - `type TextLimitKind = "length" | "nesting"`;
    `interface TextLimitViolation { kind; measured: number; limit: number }`
  - `codePointLength(text: string): number` (equals `[...text].length`)
  - `textLimitViolation(text: string): TextLimitViolation | null`
  - `describeTextLimit(v): string` (same strings as the server)
  - `TEXT_LENGTH_NOTICE`, `LINK_NESTING_NOTICE` (Global Constraints copy);
    `textLimitNotice(v): string`
  - `interface OpTextLimitViolation { opIndex: number; uid: BlockUid;
    violation: TextLimitViolation }`;
    `findOpTextLimitViolation(ops: readonly BlockOp[]): OpTextLimitViolation | null`
    (judges `create` and `update_text` text, first in op order)

- [ ] **Step 1: Red tests.**
  - `textLimitsParity.test.ts` (import the JSON as `depthCap.test.ts` does):
    constants equal the fixture's; for every case, rebuilding the text from
    `parts`, `codePointLength` equals `code_points` and equals
    `[...text].length`, `linkNestingDepth` equals `nesting_depth`,
    `textLimitViolation` equals `violation` without `describe`, and
    `describeTextLimit` equals `describe`; for every generated entry,
    `linkNestingDepth(text)` equals `nesting_depth`.
  - `textLimits.test.ts`: the two notices exactly;
    `findOpTextLimitViolation` names the first over-limit `create` or
    `update_text` by index and uid, ignores `move`, `delete`,
    `set_heading`, returns null for an empty list.
  - `linkNesting.props.test.ts` (fast-check, runs with the unit suite): over
    the Task 1 token alphabet, `linkNestingDepth(t)` equals
    `1 + max(depth)` over `scanGrammar(t)`'s `page-ref` tokens, 0 when none;
    and `textLimitViolation(t)?.kind === "nesting"` exactly when
    `linkNestingDepth(t) > 32`.
- [ ] **Step 2: Run** `cd web && pnpm vitest run src/grammar/textLimits src/grammar/linkNesting`.
  Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** `scan.ts`: factor the code pass, backtick
  positions and filtered `matchBracketPairs` that `scanGrammar` already does
  into one helper both call; `linkNestingDepth` runs the same closes-stack
  as the server (pairs sorted by `open`). `codePointLength` counts without
  allocating: `text.length` minus the number of high surrogates directly
  followed by a low surrogate (a lone surrogate counts one, as the spread
  does). `textLimitViolation` skips that count when
  `text.length <= MAX_BLOCK_TEXT_CHARS`, since code points never exceed
  UTF-16 units. Nesting fast path: count non-overlapping `[[` with an
  `indexOf` loop that stops at 33.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm vitest run src/grammar`.
  Expected: PASS.
- [ ] **Step 5: Commit** `web/src/grammar/scan.ts`,
  `web/src/grammar/textLimits.ts` and the three tests:
  `web: text limit judge and nesting measure, pinned to the server's`.

---

### Task 3: `/api/ops` refuses over-limit text, CLI and MCP surface it (implementer: opus)

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (new guard beside
  `find_op_title_violation`)
- Modify: `server/src/pkm/server/ops_apply.py` (`apply_batch` calls it
  first)
- Modify: `server/tests/test_legacy_deep_brackets.py` (the `guarded` shape
  can no longer be written through ops at `DEEP`: seed it as a legacy row;
  rewrite the module docstring's first paragraph, which says no write path
  bounds nesting)
- Test: `server/tests/test_text_limits_ops.py` (new),
  `server/tests/test_cli_main_write.py`, `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `text_limit_violation`, `describe_text_limit` (Task 1).
- Produces: `ops_core.OpTextLimitViolation(op_index: int, uid: BlockUid,
  violation: TextLimitViolation)` (frozen dataclass);
  `ops_core.find_op_text_limit_violation(ops: Sequence[BlockOp]) ->
  OpTextLimitViolation | None`. `apply_batch` must call it through the
  module-global name `find_op_text_limit_violation` imported into
  `ops_apply`, because Task 9's harness teeth patch
  `ops_apply.find_op_text_limit_violation`.

Write-path evidence this task relies on (verify, do not re-derive): the CLI
(`pkm save`, `pkm edit`, `pkm batch`) and `pkm-mcp` (`save_note`,
`update_block`, `batch`) all reach `PkmClient.post_ops` in
`client/api.py`, which posts `/api/ops`; the assistant has no write tools of
its own and calls those MCP verbs over HTTP (`assistant/claude_engine.py`
starts `pkm.mcp.server`; assistant.md says so); `routes_ops.post_ops` is the
only caller of `apply_batch`; `ops_apply._execute` is the only block insert
outside the importer.

- [ ] **Step 1: Red tests** in `server/tests/test_text_limits_ops.py` (use
  the `client` fixture; create pages with `POST /api/pages`):
  - `test_create_at_the_caps_is_stored`: one create of `"x" * 1_000_000`,
    one of `nest(32)`: 200, both texts read back unchanged.
  - `test_create_past_the_length_cap_is_refused_whole`: a batch of a valid
    create then a create of `"x" * 1_000_001`: 400 with detail
    `{"index": 1, "reason": "block <uid>: text of 1000001 characters is over the limit of 1000000"}`;
    neither block exists.
  - `test_update_text_past_the_nesting_limit_is_refused`: 400, reason
    `block <uid>: [[ nested 33 levels deep is over the limit of 32`; text
    unchanged.
  - `test_limits_are_judged_before_titles`: a batch whose op 0 has a
    forbidden title ref and op 1 an over-long text answers the op 1 limit
    reason (the limit pass runs over the whole batch first, so `extract`
    never scans an over-long text).
  - `test_a_legacy_over_limit_row`: insert a block with
    `"x" * 1_000_005` straight into the table (as
    `test_legacy_deep_brackets._write_legacy_row` does): `GET` its page is
    200; a `move` and a `set_heading` of it are 200; an `update_text` to
    `"x" * 1_000_004` is 400; an `update_text` to `"short"` is 200; a
    `delete` of a second legacy over-limit row is 200.
  - `test_a_skipped_create_is_still_judged`: a create past the cap whose
    parent is missing (it would divert) is 400, not a skip.
  - In `test_cli_main_write.py`:
    `test_save_propagates_the_nesting_refusal`: `run("save", "-p", "Lim",
    nest(33))` exits 1 with `"400: op 0: block "` and `"[[ nested 33
    levels deep is over the limit of 32"` in stderr, and page `Lim` does
    not exist.
  - In `test_mcp_server.py`, beside the title-syntax case at its `batch`
    test: `update_block` with `nest(33)` returns the 400 text naming the
    limit.
- [ ] **Step 2: Run** `cd server && uv run pytest -q tests/test_text_limits_ops.py tests/test_cli_main_write.py tests/test_mcp_server.py --no-cov`.
  Expected: the new tests FAIL (200 where 400 expected).
- [ ] **Step 3: Implement** `find_op_text_limit_violation` (judges
  `CreateOp` and `UpdateTextOp` `.text`, first offender in op order) and,
  first thing in `apply_batch`, raise
  `OpError(v.op_index, f"block {v.uid}: {describe_text_limit(v.violation)}")`.
  Then update `test_legacy_deep_brackets.py` as listed.
- [ ] **Step 4: Run** the Step 2 command, then
  `uv run pytest -q tests/test_legacy_deep_brackets.py tests/test_hostile_requests.py tests/test_ops_apply.py --no-cov`.
  Expected: PASS.
- [ ] **Step 5: Commit** the source and test files above:
  `server: /api/ops refuses block text past the length and nesting limits`.

---

### Task 4: Server-made rewrites: rename, merge, title migration, page delete (implementer: opus)

**Files:**
- Modify: `server/src/pkm/server/store.py` (`rewrite_snapshotted_blocks`
  judges every rewritten text before its first `UPDATE`)
- Modify: `server/src/pkm/server/routes_pages.py` (`rename_page` maps the
  error to 422; docstring names it)
- Modify: `server/src/pkm/server/routes_migrations.py` (409 like the other
  migration refusals)
- Modify: `server/src/pkm/unlink.py` (`BlockerReason` gains `"limit"`;
  `plan_page_delete` judges `new`)
- Modify: `server/src/pkm/contracts/responses.py` (`DeleteBlockerModel.reason`
  literal and docstring)
- Modify: `web/src/components/deletePageCopy.ts` (`blockerReasonLabel`
  case `"limit"`: `the copied text would put this block over a size or nesting limit`)
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Test: `server/tests/test_text_limits_rewrites.py` (new),
  `web/src/components/deletePageCopy.test.ts`

**Interfaces:**
- Consumes: Task 1's judge.
- Produces: `store.RewriteTextLimitError(ValueError)` with `uid: BlockUid`,
  `page_title: CanonicalTitle`, `violation: TextLimitViolation`, and
  `str()` = `block <uid> on <page title repr>: <describe>`. Task 5's
  importer catches it.

Why judge here: a rename can grow a block by (new title length - old) per
link, and a page delete replaces each `((ref))` with a copy of the target's
text, so both can carry a stored block past a limit the client never sent.
Rename and merge are on the assistant's path (`rename_page` MCP verb).
`unlink_stale_text` and the stale-edit replay inside `/api/ops` are not
judged here: see the report's open risks.

- [ ] **Step 1: Red tests** in `test_text_limits_rewrites.py`:
  - `test_rename_that_grows_a_block_past_the_cap_is_refused`: page `Old`;
    a block on page `Src` holding `"[[Old]] " * 125_000` (1,000,000
    characters); `POST /api/page/Old/rename` to a 20-character title:
    422, detail starts `rename refused: block <uid> on 'Src': text of `;
    page `Old` still exists, the block text unchanged, no `block_rewrites`
    row added.
  - `test_merge_that_grows_a_block_past_the_cap_is_refused`: same, with
    the target existing and `allow_merge: true`; nothing merged.
  - `test_rename_within_the_cap_still_rewrites`: the same block at
    `"[[Old]] " * 1_000` renames normally.
  - `test_delete_inlining_past_the_cap_is_blocked`: page `P` with block B
    `"y" * 600_000`; block S on `Src` holding `"((B)) ((B))"`:
    `GET /api/delete-preview?title=P` lists S with reason `limit`;
    `DELETE /api/page/P` is 409 with that blocker; P and S unchanged.
  - `test_delete_inlining_past_the_nesting_limit_is_blocked`: B is
    `nest(20)`; S is `"[[a//" * 20 + "((B))" + "]]" * 20`: blocker `limit`.
  - `test_title_migration_maps_the_error`: monkeypatch
    `pkm.server.store.text_limit_violation` (store imports the judge by
    name, `from pkm.text_limits import text_limit_violation`) to report a
    violation for one text, call `POST /api/migrations/title-canonicalization`
    on a database with a pending migration: 409 starting
    `title migration refused: block `. (Canonicalising only folds
    whitespace in titles, so a real migration cannot grow a block; the test
    pins the mapping, not a reachable input.)
  - `deletePageCopy.test.ts`: the `limit` label.
- [ ] **Step 2: Run** `cd server && uv run pytest -q tests/test_text_limits_rewrites.py --no-cov`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** `rewrite_snapshotted_blocks`: compute every
  `(uid, original, new_text)` first, judge each changed `new_text`, raise
  `RewriteTextLimitError` (reading the block's page title) before any
  write, then write as today. `rename_page`: `except RewriteTextLimitError`
  before the `BaseException` arm: roll back, 422 with the detail string.
  `routes_migrations`: add it to the 409 tuple with the
  `title migration refused: ` prefix. `plan_page_delete`: after the
  existing `_blocker_reason`, a `text_limit_violation(new)` makes a
  `DeleteBlocker(..., "limit")`.
- [ ] **Step 4: Regenerate the API artifacts** (backend.md § Generated
  artifacts): `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`,
  then `cd web && pnpm gen-types`.
- [ ] **Step 5: Run** the Step 2 command, then
  `uv run pytest -q tests/test_openapi_sync.py tests/test_unlink.py tests/test_page_delete_unlinks.py tests/test_rename.py tests/test_rename_endpoint.py tests/test_legacy_deep_brackets.py --no-cov`
  and `cd web && pnpm vitest run src/components/deletePageCopy src/api`.
  Expected: PASS.
- [ ] **Step 6: Commit** the files above:
  `server: rename, merge, migration and page delete refuse a rewrite past the text limits`.

---

### Task 5: Importer refuses an over-limit block, naming its page (implementer: sonnet)

**Files:**
- Modify: `server/src/pkm/importer/preflight.py` (new check over `Rows`)
- Modify: `server/src/pkm/importer/run.py` (call it after `to_rows`, before
  `connect`; catch `RewriteTextLimitError` around `apply_title_migration`)
- Modify: `server/src/pkm/importer/migrate_mermaid_blocks.py`
  (`plan_migration` leaves a candidate whose fence breaches a limit
  unconverted and reports it)
- Test: `server/tests/test_import_preflight.py` (the pure check),
  `server/tests/test_importer_e2e.py` (the CLI run, beside its existing
  depth refusal), `server/tests/test_migrate_mermaid_blocks.py`

**Interfaces:**
- Consumes: Task 1's judge; Task 4's `RewriteTextLimitError`.
- Produces: `preflight.ImportTextLimitError(ValueError)` with `uid`,
  `page_title: RawTitle`, `violation`, `str()` =
  `block <uid> on <page title repr>: <describe>`;
  `preflight.validate_row_text_limits(rows: Rows) -> None` (first offender
  in `rows.blocks` order; page title from `rows.pages` by page id).

The check runs on rows, not on the parsed export, because `to_rows`
rewrites asset URLs and folds Roam mermaid components into one fence: the
rows are what lands.

- [ ] **Step 1: Red tests:**
  - `validate_row_text_limits` passes rows at both caps, and raises naming
    uid, page title and describe for a 1,000,001-character block and for a
    `nest(33)` block; an orphan lands on `RECOVERY_PAGE_TITLE` and is named
    with it.
  - CLI level: an EDN export with one over-long block exits 2, stderr
    `error: import refused: block <uid> on '<title>': text of 1000001 characters is over the limit of 1000000`,
    and no `pkm.sqlite3` is written to `--out`.
  - A mermaid component whose children join to more than 1,000,000
    characters is not converted by `plan_migration` and appears in its
    report alongside the preserved components.
- [ ] **Step 2: Run** the three test files with `--no-cov`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. The `RewriteTextLimitError`
  catch around the importer's `apply_title_migration` prints the same
  `error: import refused: ...` line and returns 2; it has no test, because
  the migration only folds whitespace in titles and cannot grow a block.
- [ ] **Step 4: Run** again, plus `uv run pytest -q tests -k "import" --no-cov`.
  Expected: PASS.
- [ ] **Step 5: Commit** the files above:
  `importer: refuse an export block past the text limits, naming its page`.

---

### Task 6: Web editor refuses an over-limit edit with a notice (implementer: opus)

**Files:**
- Modify: `web/src/outline/useBlockDraft.ts` (`admit`; `replace` judges)
- Modify: `web/src/components/BlockInput.tsx` (`onChange` admits first;
  `onPaste` pre-judges a plain paste)
- Modify: `web/src/outline/handlers.ts` (`onRefusedEdit`)
- Modify: `web/src/outline/useOutline.ts` (`run()` judges text limits
  beside the depth cap; `depthNotice` becomes `editNotice`,
  `dismissDepthNotice` becomes `dismissEditNotice`; `onRefusedEdit`
  sets it)
- Modify: `web/src/outline/undoManager.ts` (`tooDeep` becomes a refusal
  that returns the notice; `refuse` shows that notice)
- Modify: `web/src/components/UnlinkedSection.tsx` (`linkItem` judges
  `transformed.text`)
- Modify: `web/src/views/EditablePage.tsx` (renamed fields)
- Test: `web/src/outline/useOutline.textLimits.test.tsx` (new),
  `web/src/components/BlockInput.test.tsx`,
  `web/src/outline/undoManager.test.ts`,
  `web/src/outline/useOutline.depth.test.tsx` and
  `web/src/views/EditablePage.test.tsx` (renames),
  `web/e2e/text-limits.spec.ts` (new)

**Interfaces:**
- Consumes: Task 2's `textLimitViolation`, `findOpTextLimitViolation`,
  `textLimitNotice`.
- Produces: `BlockDraft.admit(next: string): boolean` (false: refused,
  notice reported, draft unchanged); `BlockDraft.replace(...)` now returns
  `boolean`; `BlockDraftOptions.onRefused(notice: string): void`;
  `OutlineHandlers.onRefusedEdit(notice: string): void`;
  `Outline.editNotice: string | null`, `Outline.dismissEditNotice(): void`.

The rule (frontend-editor.md § Rules an edit must not break gains it in
Task 10): the web never queues an op the server will refuse for a text
limit, because a terminal 4xx poisons the batch and the snapshot repair
drops its other ops with it (`sync/rejection.ts`, sync-recovery.md § A
batch the server rejects).

- [ ] **Step 1: Red tests.**
  - `BlockInput.test.tsx`:
    - typing that makes the draft `nest(33)` (fire `change` with the new
      value) leaves the textarea showing the old text, calls
      `handlers.onRefusedEdit("Links can't nest more than 32 levels deep.")`
      and calls no `onEdit`;
    - a plain paste (no Shift-Cmd-V arm) whose result would be 1,000,001
      code points is `preventDefault`ed and reports
      `"A block can't be longer than 1,000,000 characters."`; the draft is
      unchanged;
    - a paste of 999,990 astral characters into a 10-character block (the
      result is 1,000,000 code points, 1,999,990 UTF-16 units) is not
      prevented;
    - a refused change puts the caret back where the refused insertion
      began (the common-prefix length of the old and new text).
  - `useOutline.textLimits.test.tsx` (model on `useOutline.depth.test.tsx`):
    - Enter inside a fence holding `nest(40)`, at an offset that leaves the
      first half with an unclosed fence, is refused: no `enqueue`, tree
      unchanged, `editNotice` is the nesting notice;
    - backspace-at-start merging two 600,000-character blocks is refused
      with the length notice;
    - a Shift-Cmd-V outline paste with one line of 1,000,001 characters
      applies nothing;
    - a pending draft still ships when the command is refused (as the depth
      cap does);
    - the next command that applies clears the notice.
  - `undoManager.test.ts`: a redo whose ops carry a text past a limit is
    refused, the page's outline shows that limit's notice, the entry stays.
  - `web/e2e/text-limits.spec.ts` (model on `outline-depth-cap.spec.ts`:
    own page via `POST /api/pages`, deleted in `afterEach`; own
    `E2E_PORT` when run alone):
    - `page.keyboard.insertText(nest(33))` into a focused block: the notice
      shows, the textarea keeps its text, and after blur
      `GET /api/page/<title>` still holds the old text;
    - `insertText(nest(32))` is accepted and saved;
    - a synthetic `paste` event carrying 1,000,001 characters
      (`new ClipboardEvent("paste", { clipboardData: dt })`, dispatched on
      the textarea) shows the length notice and changes nothing.
- [ ] **Step 2: Run** `cd web && pnpm vitest run src/components/BlockInput src/outline/useOutline.textLimits src/outline/undoManager`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `useBlockDraft.admit(next)`: `textLimitViolation(next)`; on a
    violation call `onRefused(textLimitNotice(v))`, restore the caret in a
    microtask (React restores a controlled value synchronously after the
    handler, and a microtask runs after that but before the next event),
    return false. `replace` calls `admit` first and returns its answer.
  - `BlockInput.onChange`: `if (!draft.admit(value)) return;` before
    `ac.onEdit`. `onPaste`, for a plain text paste, builds
    `draft.text.slice(0, selStart) + text + draft.text.slice(selEnd)`; when
    `admit` refuses it, `preventDefault`. Files and the armed outline paste
    keep their paths.
  - `run()`: after the depth check, if
    `findOpTextLimitViolation(result.ops)` is non-null, refuse the command
    the same way (apply none of its ops, the draft's text ops still ship)
    and set the notice. One `editNotice` slot carries whichever refusal
    happened.
  - `undoManager`: `tooDeep` becomes
    `refusalNotice(live, ops, title): string | null` (depth first, then
    `findOpTextLimitViolation(ops)`); `dispatchUnmounted`, whose ops are
    unjudged when the page read fails, judges text limits on the recorded
    batch anyway (that needs no tree). `refuse` takes the notice.
  - `UnlinkedSection.linkItem`: a violation sets
    `{ state: "error", message: textLimitNotice(v) }` and enqueues nothing.
- [ ] **Step 4: Run** the Step 2 command, then
  `pnpm vitest run src/outline src/components src/views`,
  then the spec alone: `E2E_PORT=8975 pnpm e2e -- text-limits` (the spec
  writes only its own page; the full suite runs in Task 11).
  Expected: PASS.
- [ ] **Step 5: Commit** the files above:
  `web: refuse an edit past the text limits at the editor, with a notice`.

---

### Task 7: Replica mirror of the server guard (implementer: opus)

**Files:**
- Modify: `web/src/replica/queue.ts` (`enqueueBatch` throws
  `LocalOpError` for a text limit before the title check)
- Test: `web/src/replica/queue.test.ts`

**Interfaces:**
- Consumes: Task 2's `findOpTextLimitViolation`, `describeTextLimit`.
- Produces: `enqueueBatch` throws
  `new LocalOpError(\`block ${uid}: ${describeTextLimit(v)}\`)` (the
  server's reason string) for a batch any of whose `create`/`update_text`
  texts is past a limit; nothing is stored or applied.

This is the backstop the editor checks make unreachable in normal use: a
refused enqueue is a `rejected` replica error, which `opQueue.persist`
treats as the server's refusal (desync, authoritative repair) rather than
retaining a batch that would poison. It also keeps the ops property's
"rejection" check able to compare both sides (Task 9).

- [ ] **Step 1: Red test:** `enqueueBatch` of a create of `nest(33)` throws
  `LocalOpError` with message `block <uid>: [[ nested 33 levels deep is over the limit of 32`,
  `allBatches(db)` is empty and no block row exists; `"x" * 1_000_000` and
  `nest(32)` enqueue normally.
- [ ] **Step 2: Run** `cd web && pnpm vitest run src/replica/queue`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the check before `findOpTitleViolation`.
- [ ] **Step 4: Run** `pnpm vitest run src/replica src/sync`. Expected: PASS.
- [ ] **Step 5: Commit**:
  `web: the replica refuses an op past the text limits, as the server does`.

---

### Task 8: Reading a legacy over-nested block never recurses (implementer: sonnet)

**Files:**
- Modify: `web/src/grammar/tokenize.ts` (`tokenizeBlockUncached`)
- Test: `web/src/grammar/tokenize.test.ts`

**Interfaces:**
- Consumes: `MAX_LINK_NESTING` (Task 2).
- Produces: nothing new. When any `page-ref` token from `scanGrammar` has
  0-based `depth >= MAX_LINK_NESTING`, `tokenizeBlockUncached` builds
  `byStart` without the `page-ref` tokens. Everything else (TODO, fences,
  inline code, tags, block refs, links, emphasis, line breaks) renders as
  today; the `[[`/`]]` characters show as text; `tokenizeInline` never
  follows a run, which is its only unbounded recursion.

No write path can store such a text after Tasks 3-7; a row written before
them, or by direct SQL, still reaches every reader, and this keeps its page
rendering. The depth is read off the tokens `scanGrammar` already returns,
so it costs nothing.

- [ ] **Step 1: Red test:** `tokenizeBlock("[[a//".repeat(5000) + "[[Deep]]" + "]]".repeat(5000))`
  does not throw and contains no `page-ref` segment; a 32-deep nest still
  yields its inner `page-ref` for `[[Deep]]` as today.
- [ ] **Step 2: Run** `cd web && pnpm vitest run src/grammar/tokenize`.
  Expected: FAIL with `RangeError: Maximum call stack size exceeded`.
- [ ] **Step 3: Implement** the early return.
- [ ] **Step 4: Run** `pnpm vitest run src/grammar src/components/InlineSegments`.
  Expected: PASS.
- [ ] **Step 5: Commit**:
  `web: render a block nested past the link limit without following refs`.

---

### Task 9: Property gate: both suites draw over-limit text, with teeth (implementer: opus)

**Files:**
- Modify: `server/tests/props/model.py` (a `_limit_violation` 400 beside
  `_title_violation`, written from backend.md's rule, importing the judge
  as the model already imports `title_syntax_reason`)
- Modify: `server/tests/props/strategies.py` (`texts`: about 1 draw in 40
  is one of `nest(33)`, `nest(32)`, a fence-hidden `nest(40)`, or
  `"x" * 1_000_001`)
- Modify: `server/tests/props/test_ops_state.py` (`event()` labels:
  `text: past a limit`, `text: at the nesting limit`, `text: nest hidden in code`)
- Modify: `web/src/props/ops/arbitraries.ts` (`OVER_LIMIT_TEXTS`
  joins `forbiddenArb` for creates and edits; `nest(32)` and the
  fence-hidden `nest(40)` join `REF_TEXT`)
- Modify: `web/src/props/ops/example.ts` (a "guarded" refusal is title
  syntax or a text limit; tally `rejections["text limit"]`; `showOps`
  clips any text over 200 characters to its length and first 40)
- Modify: `server/tooling/proptest/sync_server.py`
  (`/__proptest/limits/teeth`, body `{"off": bool}`: while armed,
  `ops_apply.find_op_text_limit_violation` returns None; `reset` disarms)
- Modify: `web/src/props/sync/serverControl.ts` (`setLimitTeeth(off)`)
- Modify: `web/src/props/ops/teeth.prop.ts` (test
  `the ops property catches: the server takes text past the limits`, caught
  by `rejection:`)
- Test: `server/tests/test_proptest_sync_server.py` (the route needs auth
  and, armed, lets a `nest(33)` create through; reset disarms it)

**Interfaces:**
- Consumes: Tasks 1, 3, 7.

- [ ] **Step 1: Red:** the route test in `test_proptest_sync_server.py`;
  run `cd server && uv run pytest -q tests/test_proptest_sync_server.py --no-cov`:
  FAIL (404).
- [ ] **Step 2: Implement** the route, model, strategies, events, web
  arbitraries, example classification, `showOps` clipping, serverControl
  and the teeth test.
- [ ] **Step 3: Reach.** Server:
  `cd server && HYPOTHESIS_PROFILE=merge uv run pytest -m proptest --no-cov -q tests/props --hypothesis-show-statistics`;
  each new `event()` label appears. Web: `proptest/check.sh web --file ops`;
  the tally shows `rejections: ... text limit` above zero. Raise the draw
  weight if either is starved.
- [ ] **Step 4: Teeth.** Web: the new teeth test passes (the mutant is
  caught by `rejection:`). Server, by hand and not committed: patch
  `ops_apply.find_op_text_limit_violation` to return None (e.g. a local
  edit), run the server proptest, confirm `test_ops_state.py` fails on a
  limit text, revert. Record both outcomes in the task's report.
- [ ] **Step 5: Run** `proptest/check.sh` (both sides). Expected: PASS.
- [ ] **Step 6: Commit** the files above:
  `proptest: draw text past the limits on both sides, with teeth`.

---

### Task 10: Architecture docs and troubleshooting (implementer: opus)

Invoke the `architecture-docs` skill first. Verify every claim against the
merged code, not this plan.

**Files:**
- Modify: `docs/architecture/backend.md`:
  - § Ref grammar: replace the paragraph that says no write path bounds
    `[[` nesting with the measure (one sentence: what counts, what does
    not), the limit, where it is judged, and that the iterative walks
    stay because legacy rows can be deeper.
  - § Planning: a bullet for the text limits: judged on the client's text
    in `apply_batch` before title syntax, so `extract` never scans an
    over-long text; server-made texts inside a batch (stale unlink,
    rename replay) are not judged, and why.
  - § Hostile input table: one row for block text past the length or
    nesting limit, guard `ops_core.find_op_text_limit_violation`,
    `store.rewrite_snapshotted_blocks`, `unlink.plan_page_delete`,
    `preflight.validate_row_text_limits`; kept by the new test files.
    Update the `[[`-past-recursion-limit row to say only legacy rows reach
    it.
  - § HTTP API reference: the rename row gains the 422; the
    delete-preview row names the `limit` blocker.
  - § Generated artifacts and parity fixtures: a row for
    `shared/fixtures/text_limits_parity.json`
    (`uv run python -m pkm.text_limits_parity_dump > ../shared/fixtures/text_limits_parity.json`;
    guarded by `test_text_limits_parity_fixture.py`,
    `textLimitsParity.test.ts`; pins `text_limit_violation`,
    `link_nesting_depth`, `describe_text_limit`, the constants).
- Modify: `docs/architecture/frontend-editor.md` § Rules an edit must not
  break: one row (no draft, command, undo, paste or link-unlinked edit
  queues a text past a limit; `useBlockDraft.admit`, `run()`,
  `undoManager`; what breaks without it: the server's 400 poisons the batch
  and the repair drops its other ops). The notice paragraph under the table
  names the shared `editNotice` slot.
- Modify: `docs/architecture/frontend-rendering.md` (or wherever the
  tokenizer is documented): a block nested past the limit renders with no
  ref tokens.
- Modify: `docs/architecture/import-export-and-backup.md`: the Preflight row
  gains the text-limit refusal (`validate_row_text_limits`, on rows because
  `to_rows` rewrites text).
- Modify: `docs/architecture/checks.md` § Property gate: the ops suite's
  "Holds" names text-limit refusals on both sides.
- Modify: `docs/troubleshooting.md`: one row per bean. pkm-bppf: symptom
  "a page fails to render (`RangeError: Maximum call stack size exceeded`)
  for a block with thousands of nested `[[`"; cause, owning section,
  `pkm-bppf`. pkm-gc3n: symptom "export of a page holding one huge block
  takes memory proportional to the block"; cause, owning section,
  `pkm-gc3n`.
- Modify: `.beans/pkm-gc3n--*.md`, `.beans/pkm-bppf--*.md` by editing the
  files (no `beans` CLI): replace bppf's tokenizer checklist items with what
  shipped (write-time limit, parity fixture, render fallback, troubleshooting
  row) and tick them; add a checklist to gc3n and tick it.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `node .claude/skills/architecture-docs/check-docs.mjs`
  (mermaid parses, links resolve, no bean id in prose). Expected: clean.
- [ ] **Step 3: Commit** the docs and bean files:
  `docs: write-time text limits (added); backend ref-grammar nesting claim (corrected)`.

---

### Task 11: Gates, perf and final review package (implementer: opus)

- [ ] **Step 1:** `cd server && uv run pytest -q` (coverage enforced),
  `uv run pyrefly check`, `uv run ruff check`. Expected: all pass.
- [ ] **Step 2:** `cd web && set -o pipefail && pnpm verify` (typecheck,
  eslint brand rules, `lint:comments`, `check:fcis`, unit coverage, full
  Playwright suite, serially). Expected: exit 0.
- [ ] **Step 3:** `proptest/check.sh` (both sides). Expected: pass. A
  failure follows AGENTS.md § Testing (fix product bugs as unit tests on
  the side the bug is on).
- [ ] **Step 4:** `perf/check.sh backend` then `perf/check.sh frontend` on
  a quiet machine. The guard adds an O(1) length read and a C-speed
  `str.count` per op text on the server and a bounded `indexOf` count per
  keystroke on the web, so no count should move. A regression: read the
  diff along the regressed path, fix, re-run; bring it to Arthur only if it
  survives. Commit any baseline file the check rewrites.
- [ ] **Step 5:** Confirm `web/src/api/openapi.json` is current
  (`uv run pytest -q tests/test_openapi_sync.py --no-cov`) and
  `git status` shows nothing uncommitted but `web/node_modules`.
- [ ] **Step 6:** Write the review package (gitignored) with the perf
  table, the proptest tallies and the teeth outcomes, for the final
  strongest-model review.
