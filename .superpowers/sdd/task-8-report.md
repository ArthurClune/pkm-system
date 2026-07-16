# Task 8 report: Shared reference and TODO grammar scanner (pkm-1cq3)

## What was implemented

- **Created `web/src/grammar/scan.ts`** (Functional Core, no imports): the
  single iterative scanner producing the brief's exact `GrammarToken` union
  and `scanGrammar(text): { tokens: readonly GrammarToken[] }`.
  - Phase 1 (`scanCode`): left-to-right opaque-code pass — closed ``` fences
    win over inline code, inline code must close before the next newline —
    emitting `code-fence`/`inline-code` tokens and blanking code ranges to
    same-length spaces (exactly refs.py's `_strip_code` offsets).
  - Phase 2: TODO marker (raw text, offset 0 only, lenient bracket sides,
    `suffixEnd` = one optional whitespace char), attribute (anchored regex
    over the blanked text, span at the name), then a single walk over the
    blanked text collecting hashtags, block refs, embed prefixes, and
    bracket pairs via an **explicit stack** (`matchBracketPairs`) — no
    recursion anywhere.
  - `pageRefTokens` converts matched pairs to pre-order page-ref tokens;
    depth/parentStart count MATCHED ancestors only, so a ref inside an
    unmatched `[[` is top-level (refs.py retry semantics); a top-level ref
    directly preceded by `#` is a tag and its span includes the `#`.
  - Tokens are sorted `(start asc, end desc)` (source order, outer before
    children) and every offset is validated within the input (`validate`
    throws on violation).
- **Adapters (Step 4), all superseded private scans deleted:**
  - `tokenize.ts`: keeps only rendering-side grammar (markdown links/images,
    bare-URL autolink, emphasis, `{{query}}`, line breaks). Block pass
    consumes code-fence tokens + local query scan (query still wins over
    inline code at block level, as before); `tokenizeInline` consumes
    scanner tokens by start position, bounded to the current range, and
    emphasis recursion reuses the same absolute-offset token map (no
    rescanning). Deleted `scanDoubleBrackets`, `TODO_PREFIX`, `ATTRIBUTE`,
    `BLOCK_REF_AT`, `TAG_CHARS`.
  - `grammar/refs.ts`: regroups tokens into refs.py's shape/order
    (attribute, page-refs outer-before-inner, hashtags; dedupe; block_refs;
    embeds). Deleted its `stripCode` + recursive `scanBrackets`.
  - `replica/refs.ts`: now a rename-only adapter over `grammar/refs.ts`
    (blockRefs camelCase, embeds dropped). Deleted its recursive
    `scanBrackets` and ASCII regexes.
  - `grammar/todo.ts`: `toggleTodo` (exact `"> "` prefix preserved, bracket
    spelling echoed from token flags) + new shared `hasTodoMarker`.
  - `outline/refAtCaret.ts`: narrowest non-empty containing page-ref from
    scanner tokens; caret bounds exclude a tag's `#`; still pure (imported
    by `outline/keyboardPolicy.ts`, a Functional Core file).
  - `outline/slashCommands.ts`: `/todo` consults `hasTodoMarker` instead of
    its private regex.
- **Fixtures**: added three cases to `shared/fixtures/ref_grammar.json`
  (unicode hashtags; unclosed outer keeps balanced inner; `{{[[TODO]]}}`
  yields a TODO link). `replica/refs.test.ts` now replays ref_grammar.json
  through the replica extractor so both web extractors and the server are
  pinned to the same grammar.

## Canonical rules and intentional adapter differences

Canonical (server-mirroring) rules: UTF-16 half-open spans, source order,
outer-before-children; opaque code recorded/blanked before all reference,
TODO, attribute and hashtag recognition; malformed/unclosed syntax stays
plain text; unicode-aware hashtag charset `[\p{L}\p{N}_./-]`; hashtag
boundary = start/whitespace/`(`/blanked code; tag span includes leading `#`.

Intentional, documented behavior changes (all unpinned edge cases):
- `replica/refs.ts` hashtags are now unicode-aware (was ASCII `\w`) —
  this IS refs.py's actual behavior (Python `\w` is unicode).
- `refAtCaret`: refs inside code are opaque (Ctrl-O in `` `[[x]]` `` no
  longer navigates).
- `tokenize`: `` `x`#tag `` renders a tag (blanked-code boundary); a
  `]]` inside inline code no longer closes a ref; an attribute preceded by
  whitespace/blanked code renders from its name position (previously the
  leading whitespace was swallowed); autolink after a fence/query boundary
  requires a normal boundary char rather than treating the chunk seam as
  start-of-text; a fence *inside* an inline-code span no longer splits it.

## Deviation from the brief's file list

`shared/fixtures/refs_parity.json` was NOT modified: it is machine-generated
by `server/src/pkm/refs_parity_dump.py` and byte-pinned by
`server/tests/test_refs_parity_fixture.py`, so extending it requires editing
server code, which this task's instructions place out of scope. The new
shared Unicode/nested/malformed cases went into `ref_grammar.json` (which
`server/tests/test_refs.py` parametrizes over) and the replica extractor now
replays that fixture too, achieving the same cross-extractor pinning.

## TDD evidence

- Step 1 RED: `cd web && pnpm vitest run src/grammar/scan.test.ts` →
  `Error: Failed to resolve import "./scan" from "src/grammar/scan.test.ts"`
  (1 file failed, no tests).
- Step 2 RED: six-file matrix → `Tests 5 failed | 108 passed (113)`:
  - `extractRefs agrees with the shared ref_grammar fixture > unicode hashtags` (replica ASCII `\w`)
  - `refTitleAtCaret > refs inside code are opaque and never match`
  - `tokenizeBlock > treats blanked code as a tag boundary, matching refs.py`
  - `hasTodoMarker detects only a block-start marker (no quote prefix)`
  - `code at the start of a block is never a marker`
- Step 3 GREEN: `src/grammar/scan.test.ts` → 30 passed (two initial
  failures were arithmetic errors in my own expected spans, fixed in the
  test; implementation unchanged).
- Step 4/5 GREEN: full Step 5 matrix (scan, tokenize, refs, todo,
  refAtCaret, slashCommands, replica refs, localOps, InlineSegments) →
  `9 files, 169 tests passed`.

## Verification

- `cd web && pnpm typecheck` → clean.
- `cd web && pnpm test:coverage` → **76 files, 964 tests passed**; coverage
  **97.85% statements / 92.24% branches / 95.61% functions / 97.85% lines**
  (thresholds 95/91/89/95). New files: scan.ts 98.66% stmts (only the
  defensive validate throw uncovered), tokenize.ts 100% stmts, refs.ts /
  todo.ts / refAtCaret.ts / slashCommands.ts / replica refs.ts 100%.
- Shared fixture changed → `cd server && uv run pytest -q` →
  **395 passed**, coverage 95.72% (≥95% enforced). The three new
  ref_grammar cases pass against refs.py unchanged.
- `pnpm verify` (build + Playwright) intentionally left to the controller;
  the bean's "pnpm verify passes" criterion is left unchecked.

## Files changed

- web/src/grammar/scan.ts (new), web/src/grammar/scan.test.ts (new)
- web/src/grammar/tokenize.ts, web/src/grammar/tokenize.test.ts
- web/src/grammar/refs.ts, web/src/grammar/todo.ts, web/src/grammar/todo.test.ts
- web/src/outline/refAtCaret.ts, web/src/outline/refAtCaret.test.ts
- web/src/outline/slashCommands.ts, web/src/outline/slashCommands.test.ts
- web/src/replica/refs.ts, web/src/replica/refs.test.ts
- shared/fixtures/ref_grammar.json
- .beans/pkm-1cq3--consolidate-reference-and-todo-grammar-scanning.md

## Self-review findings

- All Step 1–2 contract cases present with exact span assertions; the 10k
  nesting case runs (4ms) and asserts first/innermost token spans.
- All six consumers adapted; grep confirms no dead references to the
  deleted scanners (`scanDoubleBrackets`, `scanBrackets`, `scanRefSpans`,
  `TODO_PREFIX*`, `BLOCK_REF_AT`, `stripCode`).
- No existing test needed semantic changes; all previously pinned
  expectations pass unchanged.
- No over-general framework: only the brief's token kinds; adapters are
  thin (replica/refs.ts is 8 lines of logic).
- Fixed during implementation: scanCode initially misclassified the empty
  inline pair of an unclosed fence as a code-fence token (caught by the
  Step 1 contract test "an unclosed fence degrades to an empty inline code
  pair"); kind is now passed explicitly.

## Concerns

- The documented tokenize edge-behavior changes (attribute leading
  whitespace now rendered as text, autolink chunk-seam rule, `` `x`#tag ``)
  are visible-rendering changes on unpinned edge cases. They follow the
  brief's canonical opaque-code/boundary contracts, but a reviewer should
  confirm they are acceptable.
- refs_parity.json untouched (see deviation above) — if the controller
  wants those cases in the generated parity fixture too, that is a small
  follow-up server change (add cases to refs_parity_dump.py + regenerate).
