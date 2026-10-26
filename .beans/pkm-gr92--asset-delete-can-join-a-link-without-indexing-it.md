---
# pkm-gr92
title: Asset delete can join a link without indexing it
status: completed
type: bug
priority: low
created_at: 2026-10-24T22:52:59Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

Found in the pkm-gc3n/bppf Task 4 work (2026-10-24). DELETE /api/assets/{sha} strips asset tokens from block text (routes_assets._strip_references) and stores the result without re-deriving refs. Removing a token can turn '[' + token + '[Foo]]' into '[[Foo]]': a link with no refs/index entry (backlinks, page existence) until the block is next edited.

- [x] Red test: delete an asset whose token sits between '[' and '[Foo]]'; refs for Foo include the block
- [x] Re-derive refs for rewritten blocks (as other server-made rewrites do), or refuse
- [x] troubleshooting.md row

## Summary of Changes

- Behaviour: DELETE /api/assets/{sha} now reindexes refs for every block it rewrites (`reindex_refs_for_text`), so a strip that joins `[` + `[Foo]]` into a link is indexed (backlinks, page existence). Forbidden or blank joined titles are skipped by `index_ref` as on any other reindex, so the delete cannot fail on them.
- Red test: a strip that joins a link must give Foo the block (was 404). Commit c3293463; openapi regenerated early (docstring change); troubleshooting.md row and files-and-assets.md/backend.md Planning text.
- Ruling: none. Follow-ups: none.
