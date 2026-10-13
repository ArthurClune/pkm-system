---
# pkm-70ty
title: 'Backlinks miss 45 ''Local copy::'' blocks: 2026-09-24 direct DB rewrite never wrote refs rows'
status: completed
type: bug
priority: normal
created_at: 2026-10-13T18:36:18Z
updated_at: 2026-10-13T19:08:40Z
---

## Symptom
`pkm refs "Local copy"` (and the Local copy page's linked references) omit some blocks that carry the attribute, e.g. `0Q1zULAf1` on AGI and `jaHs88bxy` on AI and Cyber Security. Both read `Local copy:: [Goodlinks](/api/goodlinks/...)`. Full-text search finds them; backlinks don't.

## Evidence (prod DB copy, 2026-10-13)
- 715 blocks start `Local copy::`; 670 have a `refs` row to the `Local copy` page. The 45 without one have **no refs rows at all**, and every one is a `/api/goodlinks/` link.
- 43 of the 45 share `updated_at = 1790256022414` (2026-09-24 13:20:22 UTC). That timestamp covers 64 blocks; the 8 that do have refs kept rows they already had before the rewrite (they were already `Local copy::` blocks). The other 2 of the 45 (`cOn9j4QNW`, `lae8_LHjQ`) were in the same set and have been touched since without changing text.
- `applied_batches` has no batch at that moment, so the rewrite went straight to SQLite, not through the API.
- SQLite triggers maintain only `blocks_fts`/`pages_fts` and `changes`. `refs` is written in app code (`store.reindex_refs_for_text`, called from ops_apply's ReindexRefs effect), so a direct `UPDATE blocks SET text=...` leaves refs stale.

## Not a code bug in the refs path
The backlinks query (`routes_pages._backlinks`) is a plain join on `refs`. Data is wrong; the code is right.

## Todo
- [x] Re-derive refs for the 45 blocks (a write via the API with unchanged text, or a one-off script calling `reindex_refs_for_text`); confirm `pkm refs "Local copy"` then returns 715 blocks
- [x] Sweep for other stale refs: compare each block's parsed refs against its `refs` rows across the whole DB (other direct-write batches exist; e.g. 2026-10-09 12:35 shows blocks with `[[`/`::` and no refs, which may or may not be real)
- [x] Decide whether direct-DB maintenance writes should be refused in favour of the API, or whether a `pkm` admin reindex verb should exist for after them


## Summary of Changes
Data-only repair; no code changed.

- **Root cause confirmed:** the 2026-09-24 "note migration" (worklog) rewrote 68 free-text GoodLinks notes such as `(local copy in Goodlinks)` into `Local copy::` links with direct SQL. Triggers kept FTS and `changes` current but not `refs`. The nightly export diff a3e22ed..2d48dba shows the before/after text.
- **Sweep** (server `refs.extract` vs `refs`/`block_refs`, every block, prod copy): 59 mismatches.
  - 45: the GoodLinks rewrite.
  - 1: `8YAh9mjHF` (`[[Prompt Injection]][[]]`), a leftover row to legacy blank-title page id 1.
  - 13: links to pages since deleted (e.g. `Keyboard shortcuts`, `1`, empty daily notes removed by journal cleanup). Arthur confirmed that deleting a page leaves inbound links as text by design, so these are expected and were left alone. Reindexing them would also have recreated the pages.
- **Repair:** one `pkm batch` updated each of the 46 blocks to `text + " "` and back. An identical-text update is planned as a no-op (`ops_core`, "identical"), hence the two steps. 184 ops; text verified byte-identical afterwards; page count unchanged (4483); sweep now clean apart from the 13; `pkm refs "Local copy"` returns all 715 blocks. Side effect: those 46 blocks carry a 2026-10-13 `updated_at`.
- **Prevention:** no admin reindex verb for now. The session memory recipe for direct DB maintenance writes now says triggers do not maintain `refs`, so any text change that adds or alters `[[x]]`, `#tag` or `attr::` goes through `pkm batch`.
