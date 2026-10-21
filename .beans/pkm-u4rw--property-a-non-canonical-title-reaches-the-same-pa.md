---
# pkm-u4rw
title: 'Property: a non-canonical title reaches the same page through every route'
status: in-progress
type: task
priority: normal
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T16:13:06Z
parent: pkm-a1xk
---

A cluster of past bugs where a padded or otherwise non-canonical title reached a route and missed: delete page 404'd on a page opened through `[[ Foo ]]`; a CLI rename 404'd; a todos/changed `page` filter and a `{{query}}` with `[[ Foo ]]` matched nothing; `/page/Paper%20` lost remote edits after a resync; a sidebar panel keyed by the requested title never saw other devices' edits.

## Checklist

- [ ] Server: for any title and any padding or whitespace variant that canonicalises to it (`refs.target_canonical_title`), every route and CLI verb that takes a title (page get, delete, rename, todos/changed filters, queries, sidebar entries, journal) resolves the variant to the same page as the canonical form.
- [x] Web/replica parity: the replica's `canonicalTitle` and `titleSyntaxReason` (`web/src/replica/titles.ts`) agree with the server's `target_canonical_title` and `title_syntax_reason` on a generated fixture (extend `title_syntax.json` the way the refs corpus does).
- [ ] Web: every surface that keys a session by title (`useOutlinePageLoad`, `EditableSidebarPanel`, the page loader) keys by the canonical title for any variant.
- [ ] This needs the real server and many routes, so it may belong in the `proptest/check.sh` gate as a new suite; decide after the unit-level parity part.
- [ ] Mutants: one route that skips canonicalisation; key a sidebar panel by the raw title.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
