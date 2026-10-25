---
# pkm-gr92
title: Asset delete can join a link without indexing it
status: in-progress
type: bug
priority: low
created_at: 2026-10-24T22:52:59Z
updated_at: 2026-10-25T09:52:34Z
parent: pkm-mfd0
---

Found in the pkm-gc3n/bppf Task 4 work (2026-10-24). DELETE /api/assets/{sha} strips asset tokens from block text (routes_assets._strip_references) and stores the result without re-deriving refs. Removing a token can turn '[' + token + '[Foo]]' into '[[Foo]]': a link with no refs/index entry (backlinks, page existence) until the block is next edited.

- [ ] Red test: delete an asset whose token sits between '[' and '[Foo]]'; refs for Foo include the block
- [ ] Re-derive refs for rewritten blocks (as other server-made rewrites do), or refuse
- [ ] troubleshooting.md row
