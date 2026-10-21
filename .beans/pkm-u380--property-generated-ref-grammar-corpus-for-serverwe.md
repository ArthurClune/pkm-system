---
# pkm-u380
title: 'Property: generated ref-grammar corpus for server/web refs parity'
status: todo
type: task
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:01:04Z
parent: pkm-a1xk
---

The server's `refs.extract` and the web's `extractRefs` (`web/src/replica/refs.ts`, and the grammar scanner in `web/src/grammar/`) must see the same refs in any block text. Today `shared/fixtures/refs_parity.json` pins them on a hand-picked `CASES` list in `pkm.refs_parity_dump`, and `ref_grammar.json` is hand-maintained.

Past bugs this would have caught: `[[[[Link]]]` rendered as a link to `Link` while the server created page `[Link` (`pkm-rrqu`); padded `[[ AI ]]` titles gave a page its own filter chip (`pkm-9hn0`).

## Checklist

- [ ] Add a generated corpus to `refs_parity_dump` (fixed Hypothesis seed, or a seeded generator): bracket soup with nested, unclosed and overlapping `[[`/`]]`, `((uid))`, `#tag`/`#[[tag]]`, inline and fenced code spans, `Attr::` at line starts and after newlines, padded and blank titles, NFD and emoji. Keep the hand `CASES` as they are.
- [ ] The existing `test_refs_parity_fixture.py` keeps the fixture fresh; the TS side replays every generated case (refs, kinds, block refs).
- [ ] Tally the interesting shapes in the generator and show the corpus reaches each.
- [ ] Mutant on each side (e.g. the web scanner pairing an overlapping `[[` the old way) makes the replay fail.
- [ ] Also a server-only property: `refs.extract` stays fast on long generated inputs (a generous bound, catching the quadratic-regex class from the export slowdown), only if it can be made non-flaky.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
