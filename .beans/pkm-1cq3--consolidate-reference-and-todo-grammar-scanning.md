---
# pkm-1cq3
title: Consolidate reference and TODO grammar scanning
status: completed
type: task
priority: normal
tags:
    - web
    - grammar
    - fcis
created_at: 2026-07-15T14:23:27Z
updated_at: 2026-07-16T09:20:00Z
parent: pkm-c1cg
---

## Goal

Remove duplicated balanced-reference and TODO-marker parsing across tokenizer, reference extraction, caret lookup, slash commands, and TODO toggling.

## Acceptance criteria

- [x] A shared pure scanner returns stable spans/tokens with offsets.
- [x] tokenize.ts, refs.ts, and refAtCaret.ts derive behavior from the shared scanner.
- [x] TODO marker parsing is centralized and reused by tokenization, commands, and toggling.
- [x] Malformed, nested, overflow, and round-trip cases have shared contract tests.
- [x] Public behavior remains compatible unless an intentional change is documented.
- [ ] pnpm verify passes.

## Summary of Changes

`web/src/grammar/scan.ts` (Functional Core) is now the single scanner for
reference/TODO grammar. It emits a validated, source-ordered `GrammarToken`
stream (page-ref with content span/depth/parentStart, block-ref, hashtag,
attribute, embed, todo with spelling flags + suffixEnd, inline-code,
code-fence). All six consumers are thin adapters over it: tokenize.ts
(rendering; keeps markdown links/images, autolink, emphasis, queries,
line breaks locally), grammar/refs.ts and replica/refs.ts (extraction;
replica now delegates to grammar/refs.ts), grammar/todo.ts (toggleTodo plus
the new shared `hasTodoMarker`), outline/refAtCaret.ts, and
outline/slashCommands.ts (via hasTodoMarker). The superseded private
recursive scans (`scanDoubleBrackets`, two `scanBrackets` copies,
`scanRefSpans`, regex TODO/attribute/tag/block-ref duplicates) are deleted.

Canonical rules (mirroring server/src/pkm/refs.py):

- Spans are UTF-16 code-unit offsets, half-open, source ordered, outer
  reference before children.
- Opaque code first: closed fences and same-line inline code are recorded
  and blanked (space-for-char) before any reference/TODO/attribute/hashtag
  recognition. Malformed/unclosed syntax stays plain text.
- Bracket pairs are matched iteratively with an explicit stack (10k-deep
  nesting is tested without RangeError); a ref inside an *unmatched* outer
  `[[` counts as top-level, exactly like refs.py's retry semantics.
- Hashtag titles use `[\p{L}\p{N}_./-]` (unicode-aware, approximating
  Python's `\w`); the boundary before `#` is start-of-text, whitespace, `(`,
  or blanked code.
- A tag page-ref's span includes its leading `#`; `#[[x]]` needs no word
  boundary before the `#`.
- The TODO marker is recognized at offset 0 only, each bracket side
  independently lenient, with `suffixEnd` covering the one optional
  whitespace character the renderer swallows.

Intentional behavior changes (all unpinned edge cases, now unified on the
server grammar):

- replica/refs.ts hashtags are now unicode-aware (was ASCII `\w`), matching
  refs.py and grammar/refs.ts; pinned by new shared fixture cases.
- refAtCaret: refs inside code are opaque — Ctrl-O inside `` `[[x]]` `` no
  longer navigates.
- tokenize: `` `x`#tag `` now renders a tag (code blanks to whitespace, the
  refs.py boundary rule); a bracket pair's closing `]]` is no longer found
  inside inline code; an attribute after leading whitespace/blanked code
  renders at its name position instead of swallowing the prefix; bare-URL
  autolinking after a fence/query boundary now requires the usual
  whitespace/chunk boundary.

New shared fixture cases in shared/fixtures/ref_grammar.json (unicode
hashtags, unclosed-outer-keeps-inner, TODO-marker-yields-TODO-link) are
validated by server/tests/test_refs.py and replayed by BOTH web extractors;
refs_parity.json is intentionally unchanged because it is machine-generated
from server/src/pkm/refs_parity_dump.py and byte-pinned by
test_refs_parity_fixture.py (extending it requires a server change, out of
scope here). replica/refs.test.ts now replays ref_grammar.json instead.
