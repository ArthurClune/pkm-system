---
# pkm-25u5
title: strip_asset_tokens is quadratic in asset tokens per block
status: completed
type: bug
priority: normal
created_at: 2026-10-24T21:19:31Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

Found in the pkm-gc3n/bppf review (2026-10-24). routes_assets._strip_references -> strip_asset_tokens takes time quadratic in the number of asset tokens in one block: 18 s at 2,000 tokens, ~140 s end to end at 5,000 (DELETE /api/assets/{sha}). One crafted block (allowed under the 1,000,000 code point cap) can stall the server's single writer.

- [x] Red test: strip time on N tokens scales linearly (or a bounded-time test at 5,000 tokens)
- [x] Single forward pass
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: `strip_asset_tokens` (assets_core) now strips in one forward pass; the quadratic per-token probe is gone. Bound: work linear in the text, pinned by a step-count scaling test on unclosed `[`/`![`/`{{pdf:` openers (red at 2,000 vs 500 tokens, 6.0M-16.0M steps; green after) and an oracle property against a reference strip with reach floors. Test inputs needed a newline to be quadratic on the old code (a brief deviation).
- Commit: 1351c1fb. troubleshooting.md row under Files and assets (row on a delete that takes minutes with thousands of unclosed `[`).
- Ruling: none. Follow-ups: none for this bean.
