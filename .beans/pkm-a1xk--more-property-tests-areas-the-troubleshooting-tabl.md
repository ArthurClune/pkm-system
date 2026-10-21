---
# pkm-a1xk
title: 'More property tests: areas the troubleshooting table shows need them'
status: todo
type: epic
created_at: 2026-10-21T14:00:52Z
updated_at: 2026-10-21T14:00:52Z
---

Property tests for the areas the troubleshooting table shows were bitten by hand-found bugs and have no property coverage today. Chosen from a review of `docs/architecture/` and `docs/troubleshooting.md` after `pkm-e7z9` found three real bugs in the local-docs links.

Suggested order: the ref-grammar corpus, text hashing, and asset tokens first (cheap, reuse existing plumbing, and the hashing one may be a live bug), then rename, the outline helpers, the no-500 sweep, title canonicalization, and the regex-anchor lint.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
