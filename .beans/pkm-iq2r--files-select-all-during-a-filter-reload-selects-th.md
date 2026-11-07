---
# pkm-iq2r
title: 'Files: Select all during a filter reload selects the old filter''s files, and Delete removes them'
status: todo
type: bug
priority: high
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:46Z
updated_at: 2026-11-07T18:42:46Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding webui F2. Verdict: HOLDS, reproduced in vitest ("50 of 1
files", "50 selected", old-filter PNGs listed under the PDF filter). A gap in
the completed pkm-3622.

## Symptom
Filter A loaded; change a filter; click Select all while "Loading..." shows.
The reload lands first, then selectAll's page fetches commit under the same
generation, merging A's first page with B's later pages, all selected.
Delete removes files outside the filter, and for orphans the confirm doesn't
name them. Smaller: during the 250 ms debounce `loadMore` appends filter-B
rows to the filter-A list. A reload failure keeps the old selection live
under "Could not load files.".

## Cause
`views/Files.tsx`: `reload` bumps `generation` when the debounce fires, not
when filters change, and leaves `items`/`total`/`selected`. `selectAll`
starts from the old `items`/`total` with the new `filters` and the reload's
own generation.

## Fix
- [ ] Red tests (Select all and Load more started after the filter change)
- [ ] Bump the generation and clear `selected` when filters change
- [ ] Select all / Load more only when `state === "ready"` for the current generation; clear the selection on reload error
