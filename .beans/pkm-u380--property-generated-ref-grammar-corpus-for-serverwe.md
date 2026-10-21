---
# pkm-u380
title: 'Property: generated ref-grammar corpus for server/web refs parity'
status: completed
type: task
priority: normal
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:31:59Z
parent: pkm-a1xk
---

The server's `refs.extract` and the web's `extractRefs` (`web/src/replica/refs.ts`, and the grammar scanner in `web/src/grammar/`) must see the same refs in any block text. Today `shared/fixtures/refs_parity.json` pins them on a hand-picked `CASES` list in `pkm.refs_parity_dump`, and `ref_grammar.json` is hand-maintained.

Past bugs this would have caught: `[[[[Link]]]` rendered as a link to `Link` while the server created page `[Link` (`pkm-rrqu`); padded `[[ AI ]]` titles gave a page its own filter chip (`pkm-9hn0`).

## Checklist

- [x] Add a generated corpus to `refs_parity_dump` (fixed Hypothesis seed, or a seeded generator): bracket soup with nested, unclosed and overlapping `[[`/`]]`, `((uid))`, `#tag`/`#[[tag]]`, inline and fenced code spans, `Attr::` at line starts and after newlines, padded and blank titles, NFD and emoji. Keep the hand `CASES` as they are.
- [x] The existing `test_refs_parity_fixture.py` keeps the fixture fresh; the TS side replays every generated case (refs, kinds, block refs).
- [x] Tally the interesting shapes in the generator and show the corpus reaches each.
- [x] Mutant on each side (e.g. the web scanner pairing an overlapping `[[` the old way) makes the replay fail.
- [x] Also a server-only property: `refs.extract` stays fast on long generated inputs (a generous bound, catching the quadratic-regex class from the export slowdown), only if it can be made non-flaky.

## Ruling

The generated corpus found a server/web disagreement on code-span precedence:
a lone backtick before a fence run on the same line. Arthur ruled that the
server follows the web's single left-to-right pass (whichever code marker
starts first wins, which is what the renderer shows). `refs.strip_code` is now
one alternation regex, fence branch first, applied leftmost-first.

## Summary of Changes

- `pkm.refs_parity_dump`: seeded generated corpus (400 cases), shape
  predicates and `shape_tally`; fixture regenerated (hand cases first).
- `test_refs_parity_fixture.py`: reach test and ordering test.
- `refs.strip_code`: left-to-right code pass; shrunk case kept in
  `test_refs.py`, plus an `ref_grammar.json` case both sides replay.
- Fast-extract checks on 200k-character inputs (5s bound) on both sides,
  including `` ```a\n `` repeated, `` ```\n ``, `` ``` ```a `` and
  `` ```a```a ``. They found two quadratic scans: a rescan for a closer per
  unclosed opener, fixed by a failure memo in `refs.strip_code` (now a
  left-to-right loop) and `scanCode`; and the web's `^\s*` attribute pattern
  on all-blank text, fixed by skipping the whitespace first as refs.py does.
  Mutant: removing the memo fails the `` ```a\n `` and `` ```a```a `` checks
  on each side.
- Docs: backend.md fixture row and precedence note, troubleshooting row.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
