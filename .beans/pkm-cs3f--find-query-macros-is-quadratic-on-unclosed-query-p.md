---
# pkm-cs3f
title: find_query_macros is quadratic on unclosed query prefixes
status: completed
type: bug
priority: low
created_at: 2026-10-24T15:59:35Z
updated_at: 2026-10-24T16:52:16Z
parent: pkm-mfd0
---

Found in pkm-8bga fix round 1. pkm.export.resolve.find_query_macros rescans to the end of the text for every unclosed '{{query: {' prefix: O(n^2) in one block's text, and no block text length cap exists. Called by resolve_text (charged per call by the export budget, but a single call is still quadratic) and by routes_export._gather_resolution_data (unbudgeted; see pkm-stny). Fix idea: one forward scan that, once a prefix fails to close, knows no later prefix can close either (depth only falls at '}'), or track the nearest balanced close. Mirror web/src/grammar/tokenize.ts scanMacro if it has the same shape.


## Summary of Changes

`find_query_macros` (`server/src/pkm/export/resolve.py`) no longer walks forward from each prefix. `_brace_balances` makes one pass over the braces. It records the running balance before each `{`, and for each balance value the ordered positions of the `}` characters that bring it there. A macro at i closes at the first `}` after i+2 that returns the balance to its value before i. The balance moves one step at a time, so it cannot pass that value without landing on it. That `}` is found by bisection, and the skip past a closed macro is kept. The index is built only when a prefix is found. Candidate `{{` positions come from `str.find`.

- The output is the same as the old scan. A Hypothesis differential test against a verbatim copy of the old scan ran 3,000 examples, and a seeded run checked 50,000 texts of up to 200 pieces.
- The work is linear. Loop steps grow 4.0x from N to 4N unclosed prefixes (old: 16x).
- The reviewer's shape (a 16k block of `{{query:`, referenced 200 times) renders in 0.18 s instead of 97 s. One scan of a 1M-character block takes 0.06 s.
- Not changed: `web/src/grammar/tokenize.ts` `scanMacro` has the same quadratic shape, plus a `text.slice(i)` per `{{`. The controller files that separately.
