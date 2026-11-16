---
# pkm-bvdv
title: FailedHealthCheck (filter_too_much) in test_accepted_options_add_no_refs
status: completed
type: bug
created_at: 2026-11-16T14:08:58Z
updated_at: 2026-11-16T14:08:58Z
---

Symptom: a full server pytest run failed with hypothesis.errors.FailedHealthCheck (filter_too_much) in tests/test_macro_options.py::test_accepted_options_add_no_refs; it passed when rerun alone.

Cause: the test drew option values from parts that include "((" and "))" and discarded refused cases with assume(options_refusal(opts) is None). Since "((" and "))" joined the refused set in macro_options, only about 40% of cases survived and the survivors were nearly all blanks, so the health check tripped on unlucky generation history and the property was close to vacuous.

Fix: no assume. The strategy adds single bracket characters, letters, colon and dash to the ref-like parts, and the test returns early on a refused case (a refusal is a valid outcome) and otherwise asserts that formatting adds no refs. Dropping "((" and "))", or "[[", "]]" and "#", from the refused set makes it fail.

## Summary of Changes

Rewrote the strategy and removed assume in test_accepted_options_add_no_refs (server/tests/test_macro_options.py). No source change.
