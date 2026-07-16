---
# pkm-ph1m
title: 'Support Roam {{[[pdf]]: url}} embed macro'
status: in-progress
type: feature
priority: normal
created_at: 2026-07-16T19:47:43Z
updated_at: 2026-07-16T19:59:43Z
---

382 blocks use {{[[pdf]]: /assets/...}} and 132 use {{pdf: /assets/...}} (Roam import). The grammar only special-cases {{query}}, so these render as literal text + [[pdf]] page link instead of the PDF viewer (reported: [[July 7th, 2026]] SITS Readiness Assessment).

Design decisions:
- Tokenize both spellings ({{[[pdf]]: url}} and {{pdf: url}}), mirroring QUERY_PREFIX
- New segment kind dispatches to PdfEmbed when isPdfAssetHref(url); label = decodeURIComponent of the last path segment (fallback: raw segment on malformed encoding)
- Non-asset URLs (none in data): fall back to existing safe-link rendering
- No data migration; blocks stay in Roam-native spelling

- [x] Tokenizer: pdf-embed segment (TDD)
- [x] InlineSegments dispatch + label derivation (TDD)
- [x] E2E: macro-syntax block renders the viewer
- [x] Full verify
