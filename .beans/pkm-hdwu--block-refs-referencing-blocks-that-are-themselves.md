---
# pkm-hdwu
title: Block refs referencing blocks that are themselves block refs don't expand
status: completed
type: bug
priority: normal
created_at: 2026-07-12T08:08:31Z
updated_at: 2026-07-12T08:12:18Z
---

On page 'LLM Economics', line 'c.f. ((g3h8gnNxP))' renders unexpanded. Root cause: block g3h8gnNxP's text is itself '((oyfQqI8fI))'. Server _block_ref_texts only resolves one level of ((refs)); client BlockRef supports nested rendering up to depth 3 but the nested uid is missing from block_ref_texts, so it renders as unresolved. Fix: make server resolution transitive (closure over fetched texts, cycle-safe).

## Summary of Changes

- `server/src/pkm/server/routes_pages.py`: `_block_ref_texts` now resolves
  ((refs)) transitively — iterates fetch → extract refs from fetched texts →
  fetch again until closure. A `seen` set makes cycles and repeated missing
  uids terminate. Journal route shares the helper, so it's fixed there too.
- `server/tests/test_page_endpoint.py`: two new tests — nested chain
  (`((a))` → text `((b))` → content) and cycle + missing-uid safety.
- Verified e2e on a scratch server (port 8975) with the exact prod chain from
  'LLM Economics': line renders "c.f. Densing Law of LLMs #Paper", zero
  unresolved refs in DOM.
