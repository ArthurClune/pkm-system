---
# pkm-25u5
title: strip_asset_tokens is quadratic in asset tokens per block
status: todo
type: bug
priority: normal
created_at: 2026-10-24T21:19:31Z
updated_at: 2026-10-24T21:19:31Z
parent: pkm-mfd0
---

Found in the pkm-gc3n/bppf review (2026-10-24). routes_assets._strip_references -> strip_asset_tokens takes time quadratic in the number of asset tokens in one block: 18 s at 2,000 tokens, ~140 s end to end at 5,000 (DELETE /api/assets/{sha}). One crafted block (allowed under the 1,000,000 code point cap) can stall the server's single writer.

- [ ] Red test: strip time on N tokens scales linearly (or a bounded-time test at 5,000 tokens)
- [ ] Single forward pass
- [ ] troubleshooting.md row
