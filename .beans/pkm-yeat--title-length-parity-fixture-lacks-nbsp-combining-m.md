---
# pkm-yeat
title: Title-length parity fixture lacks NBSP, combining-mark and lone-surrogate cases
status: completed
type: task
priority: low
created_at: 2026-10-26T16:13:09Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

From the security/batch-server final review (T12 Minor 8). The server/web parity fixture for title length checks no NBSP, combining marks or lone surrogates; verified by hand in T12 only.

- [x] Add the cases to the shared fixture -- title_length.json gains NBSP edges and runs, combining marks, and lone-surrogate cases; both sides gain a surrogate-load test
- [x] Both sides pass -- server test_title_length_fixture.py (26 passed) and web titleLength.test.ts pass; one mutant on each side goes red

## Summary of Changes

- `shared/fixtures/title_length.json`: 6 title cases and 2 text cases covering NBSP edges and runs, combining marks (counted apart, not NFC-folded) and lone surrogates.
- `server/tests/test_title_length_fixture.py` (26 passed) and `web/src/grammar/titleLength.test.ts`: both gain a surrogate-load test.
- Mutants: server `title_length_over` with NFC folding fails `combining_marks_count_apart` (1 failed, 25 passed); web `codePointLength(text)` in place of the fold fails 5 (`a_fold_brings_it_to_the_cap`, `a_fold_strips_its_edges`, `a_run_counts_once`, `nbsp_edges_strip`, `an_nbsp_run_counts_once`). The reviewer re-ran the web mutant.

Rulings:
- Minors deferred: the `titles.test.ts` JSON reader is not asserted unreplaced; the new `texts` cases' teeth are unmeasured on the linked-title path (no mutant of `linkedTitleRefusal`'s fold).
