---
# pkm-0zi8
title: 'Web tokenizer: scanMacro is quadratic on unclosed {{ prefixes'
status: in-progress
type: bug
priority: low
created_at: 2026-10-24T16:57:14Z
updated_at: 2026-10-25T09:38:33Z
parent: pkm-mfd0
---

Found in pkm-8bga fix round 3 (server side fixed there as pkm-cs3f). web/src/grammar/tokenize.ts scanMacro rescans to the end of the text for every unclosed QUERY_PREFIX or PDF_PREFIX, and copies the rest of the text with text.slice(i) at every '{{' position, so even a block of plain '{{{{...' costs O(n^2) in the browser on render. Fix: a sticky regex (lastIndex) for the prefix match instead of slice, and the server's method for the close: a single forward pass with a stack of open prefixes (pkm.export.resolve.find_query_macros). Differential test against the old scanner. Related: pkm-bppf (deep [[ nesting overflow).

Fixed by 389380c0, which replaced the per-opener brace walk with one stack pass (braceCloses); the remaining prefix.exec(text.slice(i)) is an O(1) substring in V8 and JSC, so no sticky-regex rewrite is needed. Pinned by two tests in web/src/grammar/tokenize.test.ts ("tokenizeBlock on long runs of math and macro openers"): unclosed `{` at the length cap, and unclosed `{{[[query]]: ` ×76,923, which takes 73 s under the pre-389380c0 walk and 0.3 s now.
