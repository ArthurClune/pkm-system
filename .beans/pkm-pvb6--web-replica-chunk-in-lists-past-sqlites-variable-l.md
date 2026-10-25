---
# pkm-pvb6
title: 'Web replica: chunk IN-lists past SQLite''s variable limit'
status: in-progress
type: bug
priority: low
created_at: 2026-10-23T18:46:47Z
updated_at: 2026-10-25T09:38:33Z
parent: pkm-mfd0
---

The offline replica has the same unchunked IN-lists the server just lost: web/src/replica/localApi/tree.ts resolveRefUids, blockRefCounts and fetchAncestors each bind one variable per id, so a page of tens of thousands of blocks throws in the offline gateway where the server now answers. (pages.ts backlinks pageIds is bounded by the backlink limit.) Found in review of pkm-ec46.

## Fix
- [x] Reproduce: 32,766 ids pass and 32,767 throw "too many SQL variables" in the wasm build
- [x] Failing tests in web/src/replica/localApi/tree.test.ts ("id sets past SQLite's variable limit"): blockRefCounts, fetchAncestors, resolveRefUids among 40,000 uids; pagePayload of a 33,000-block page
- [x] Bind each id set as one JSON array, `IN (SELECT value FROM json_each(?))`, in tree.ts (all three) and pages.ts backlinks, rather than porting chunk_ids: one variable whatever the size, one statement per read, the replica's existing idiom (replayLog.ts, rewind.ts)

## Summary of Changes

1bd93ae7: `resolveRefUids`, `blockRefCounts` and `fetchAncestors` in `replica/localApi/tree.ts`, and the backlinks `pageIds` list in `pages.ts`, now bind each id set as one JSON array, `IN (SELECT value FROM json_each(?))`. That needs one variable at any size and keeps one statement per read. Tests in `tree.test.ts` cover 40,000 ids and a 33,000-block page. Docs: `backend.md § Database` states the shim's rule beside `chunk_ids`, and a troubleshooting row was added under "A replica or view that disagrees with the server".
