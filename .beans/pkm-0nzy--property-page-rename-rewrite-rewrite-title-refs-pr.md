---
# pkm-0nzy
title: 'Property: page rename rewrite (rewrite_title_refs) preserves everything but the renamed refs'
status: todo
type: task
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:01:04Z
parent: pkm-a1xk
---

`rename.rewrite_title_refs` / `rewrite_title_refs_map` rewrite `[[Old]]`, `#Old`, `#[[Old]]` and `Old::` in other blocks when a page is renamed or merged. No property covers it: the server state machine does not draw renames. Past bugs: a rename corrupted a code span or the indent before a `Title::` attribute, and missed an attribute after a newline.

## Checklist

- [ ] Generate block texts mixing refs to the old title (all ref forms, padded variants that canonicalise to it), refs to other titles, code spans and fences containing `[[Old]]`, and attributes at line starts and after newlines.
- [ ] Properties: `refs.extract` of the rewritten text equals that of the original with the old canonical title replaced by the new; text outside the rewritten refs is byte-identical (code spans untouched); rewriting with the same title is the identity; renaming Old to New and back restores the original whenever New did not already occur.
- [ ] Draw new titles that need different ref syntax (a title with `]]`, spaces, `#`) and check the rewrite still parses as a ref to the new title, or the route refuses the rename.
- [ ] Mutants: anchor attributes at column 0; skip code-span masking.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.
