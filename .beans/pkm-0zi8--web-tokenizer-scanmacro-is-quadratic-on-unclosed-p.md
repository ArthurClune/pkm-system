---
# pkm-0zi8
title: 'Web tokenizer: scanMacro is quadratic on unclosed {{ prefixes'
status: todo
type: bug
priority: low
created_at: 2026-10-24T16:57:14Z
updated_at: 2026-10-24T16:57:14Z
parent: pkm-mfd0
---

Found in pkm-8bga fix round 3 (server side fixed there as pkm-cs3f). web/src/grammar/tokenize.ts scanMacro rescans to the end of the text for every unclosed QUERY_PREFIX or PDF_PREFIX, and copies the rest of the text with text.slice(i) at every '{{' position, so even a block of plain '{{{{...' costs O(n^2) in the browser on render. Fix: a sticky regex (lastIndex) for the prefix match instead of slice, and the server's brace-balance bisection (pkm.export.resolve.find_query_macros) for the close. Differential test against the old scanner. Related: pkm-bppf (deep [[ nesting overflow).
