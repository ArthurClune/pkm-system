---
# pkm-pvb6
title: 'Web replica: chunk IN-lists past SQLite''s variable limit'
status: todo
type: bug
priority: low
created_at: 2026-10-23T18:46:47Z
updated_at: 2026-10-23T18:46:47Z
parent: pkm-mfd0
---

The offline replica has the same unchunked IN-lists the server just lost: web/src/replica/localApi/tree.ts resolveRefUids, blockRefCounts and fetchAncestors each bind one variable per id, so a page of tens of thousands of blocks throws in the offline gateway where the server now answers. (pages.ts backlinks pageIds is bounded by the backlink limit.) Found in review of pkm-ec46.
