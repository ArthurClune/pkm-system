---
# pkm-ey1f
title: 'Small perf hygiene: FK-check scope, lazy Bluesky iframes, Journal content-visibility, BlockRefProvider/PdfViewer growth'
status: todo
type: task
priority: low
created_at: 2026-09-01T21:28:07Z
updated_at: 2026-09-01T21:28:07Z
parent: pkm-fgjg
---

Tier 3 — a bag of small, independent items from the 2026-09-01 investigation. Do whichever are cheap when nearby; split out anything that grows.

1. **`reapplyPending` runs a whole-database `PRAGMA foreign_key_check` per pending batch per window** (`web/src/replica/apply.ts:114-160`, from pkm-qvlx). K pending batches → K+1 full-graph scans per pulled window. Cost unmeasured; if a profile shows it matters, scope to `PRAGMA foreign_key_check(blocks)` or skip when the batch touches no FK column. Keep the FK-safety guarantee (savepoint rollback on violation).
2. **Bluesky embed iframes are eager and never unload** — `web/src/components/BlueskyEmbed.tsx:94-102` has no `loading="lazy"`; every other image in the app lazy-loads (`AssetImage.tsx:44`, `Files.tsx:90`). One line; optionally unmount when far off-screen keeping `--bluesky-height` so layout doesn't jump.
3. **Journal never unmounts loaded days** (`views/Journal.tsx:181-186`, deliberate to avoid resync churn — which pkm-5fak removes). `content-visibility: auto` on off-screen day sections is a cheap partial; full virtualisation is probably not worth it.
4. **`BlockRefProvider`** rebuilds `{...fetched, ...seed}` per resolved batch (`components/BlockRefProvider.tsx:44`), new identity for all consumers; `requestedRef` only grows. Store in a `Map` behind `useSyncExternalStore`. Related deferred bug pkm-1w6u (resolved texts never invalidate).
5. **`PdfViewer`'s mounted-page `Set` only grows** (`components/PdfViewer.tsx:55-110`); evict pages beyond a window either side of the viewport.
6. No `prefers-reduced-motion` block in `styles.css` — accessibility, not energy; note only.

## Checklist
- [x] 1 FK-check scope (measure first) — measured, NOT worth scoping, no code change.
      Timed `PRAGMA foreign_key_check` against the replica schema in the same
      in-memory sqlite-wasm the replica tests use (50 reps, warmed):

      | blocks | FK-bearing rows | whole-db | blocks | refs | block_refs | sum of the three |
      |-------:|----------------:|---------:|-------:|-----:|-----------:|-----------------:|
      |  1 000 |           2 999 | 0.315 ms | 0.068  |0.133 |    0.111   |         0.318 ms |
      |  5 000 |          14 999 | 1.717 ms | 0.335  |0.768 |    0.623   |         1.723 ms |
      | 20 000 |          59 999 | 7.537 ms | 1.404  |3.371 |    2.727   |         7.408 ms |

      The scoped remedy the bean proposes provably saves nothing: `blocks`,
      `refs` and `block_refs` ALL bear FKs, so a correct scoped check must run
      all three, and the unscoped pragma already visits only FK-bearing tables
      (whole-db == sum-of-three within noise at every size). Scoping to
      `blocks` alone would be a correctness regression, not an optimisation --
      the file header's WITHOUT ROWID reasoning is specifically about `refs`
      and `block_refs` violations. The only remaining lever ("skip when the
      batch touches no FK column") is a redesign of the pkm-qvlx guarantee,
      not hygiene; deliberately not attempted here.
- [x] 2 Bluesky lazy
- [ ] 3 Journal content-visibility
- [ ] 4 BlockRefProvider store
- [ ] 5 PdfViewer eviction
