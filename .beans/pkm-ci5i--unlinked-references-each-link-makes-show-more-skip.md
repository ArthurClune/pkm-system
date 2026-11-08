---
# pkm-ci5i
title: 'Unlinked references: each Link makes Show more skip one unseen item'
status: completed
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:46Z
updated_at: 2026-11-08T14:27:29Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding webui F3. Verdict: HOLDS.

Open the section (items 0-19, offset 20), Link 3 of them, click Show more:
the server's list has shifted left by 3 (`routes_pages.get_unlinked`
excludes blocks that now ref the page; `LIMIT ? OFFSET ?`), so items 20-22
are never shown, and the header count (`total - hiddenUids.size`) is off.
Hits every link-cleanup pass on a page with more than 20 unlinked mentions.

- [x] Red test
- [x] `components/UnlinkedSection.tsx` `linkItem`: decrement `offset` and `total` per delivered link (or refetch from 0)

## Summary of Changes

A delivered Link now removes its block from the loaded groups and one from
`total`, and is remembered so a batch answered before it landed cannot bring
it back. Show more asks from the loaded blocks still listed, counting hidden
(settled, undelivered) ones out: that can only re-fetch a block mergeGroups
drops. Red test in sections.test.tsx drives a server fake whose list shifts
as links land. Docs: frontend.md § Unlinked references; troubleshooting row.
