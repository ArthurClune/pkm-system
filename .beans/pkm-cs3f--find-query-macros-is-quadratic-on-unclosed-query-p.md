---
# pkm-cs3f
title: find_query_macros is quadratic on unclosed query prefixes
status: completed
type: bug
priority: low
created_at: 2026-10-24T15:59:35Z
updated_at: 2026-10-24T17:04:25Z
parent: pkm-mfd0
---

Found in pkm-8bga fix round 1. pkm.export.resolve.find_query_macros rescans to the end of the text for every unclosed '{{query: {' prefix: O(n^2) in one block's text, and no block text length cap exists. Called by resolve_text (charged per call by the export budget, but a single call is still quadratic) and by routes_export._gather_resolution_data (unbudgeted; see pkm-stny). Fix idea: one forward scan that, once a prefix fails to close, knows no later prefix can close either (depth only falls at '}'), or track the nearest balanced close. Mirror web/src/grammar/tokenize.ts scanMacro if it has the same shape.


## Summary of Changes

`find_query_macros` (`server/src/pkm/export/resolve.py`) no longer walks forward from each prefix. A macro at i closes at the first `}` after its `{{` that returns the running brace balance to its value before i. The balance moves one step at a time, so it cannot pass that value without landing on it. One forward pass over the prefixes and braces (`_MACRO_SCAN_RE`) finds every close. An open prefix waits on a stack, and since a later prefix opens at a higher balance, only the top one can close at any `}`. The state is `array("q")` integers per prefix and nothing per brace. A first version indexed every brace and cost up to 190 B per character; the forward pass replaced it on the same branch. A closed macro still hides any prefix inside it. Texts without a prefix return at once.

- The output is the same as the old scan. A Hypothesis differential test against a verbatim copy of the old scan ran 3,000 examples, and a seeded run checked 50,000 texts of up to 200 pieces.
- The work is linear. Loop steps grow 4.0x from N to 4N unclosed prefixes (old: 16x).
- Memory: one prefix followed by 1M braces peaks at about 2.5 KB, and a text made only of `{{query:` at 5.2 B per character. `"{{query:" + "}" * 5_000_000` exports at 96 MiB RSS.
- The reviewer's shape (a 16k block of `{{query:`, referenced 200 times) renders in 0.18 s instead of 97 s. One scan of a 1M-character block takes 0.06 s.
- Not changed: `web/src/grammar/tokenize.ts` `scanMacro` has the same quadratic shape, plus a `text.slice(i)` per `{{`. The controller files that separately.
