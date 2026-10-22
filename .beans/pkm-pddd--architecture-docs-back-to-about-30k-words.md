---
# pkm-pddd
title: Architecture docs back to about 30k words
status: completed
type: epic
priority: normal
created_at: 2026-10-22T19:53:55Z
updated_at: 2026-10-22T21:08:56Z
---

docs/architecture/ grew from about 23k words (2026-09-23) to 65k, and docs/troubleshooting.md from 3k to 12k, in a month. Five reviews (scratchpad reports) found the growth comes from proof walk-throughs, hand-kept catalogues that copy the code, the same fact in several docs, and material appended in ship order. Aim: back to about 30k words in total without losing any invariant, its reason, or a must-not-break identifier. Rule for what stays: a doc states what the code and its checks cannot tell you.

## Checklist
- [x] Sync docs (pilot): sync-and-offline, sync-recovery, sqlite-wasm-patch; server facts move to backend.md
- [x] Arthur reviews the pilot's depth
- [x] backend.md
- [x] Frontend docs: frontend, frontend-editor, frontend-rendering, styling
- [x] Gate docs: performance-checks, property-checks, enforced-checks become one checks.md; catalogues move beside the code
- [x] Smaller docs: overview, assistant, cli-and-mcp, files-and-assets (goodlinks folds in), import-export-and-backup
- [x] docs/troubleshooting.md: fixed-form Cause column, refile misfiled rows, subgroup Sync and Backend
- [x] Stop the regrowth: AGENTS.md § Architecture docs, architecture-docs skill, check-docs.mjs reports long table cells
- [x] Fix the factual errors the reviews found
- [x] Whole-branch review on the strongest model; check-docs passes


## Summary of Changes

| | Before | After |
|---|---:|---:|
| docs/architecture/ | 64.6k words, 17 docs | 30.3k words, 14 docs |
| docs/troubleshooting.md | 12.0k words, 170 rows | 6.8k words, 141 rows |

- Every doc cut to what the code and its checks cannot say, sync first as a pilot whose depth Arthur approved. Sync server facts moved to backend.md; replica database access moved to sync-and-offline.md.
- performance-checks, property-checks and enforced-checks became one checks.md: a table of every check plus the design points a gate maintainer could break. The catalogues were already described beside their code.
- goodlinks.md and backend.md § Local documents folded into files-and-assets.md.
- troubleshooting.md: Cause is one mechanism sentence plus the guard; rows refiled by owner and grouped by symptom; duplicates merged with every Ref kept.
- Stopping the regrowth: the architecture-docs skill gained "a doc states what the code cannot" (tested against the regex-lint change, whose real doc update copied the lint's cases: the old wording copied them 3/3, the new 0/3); AGENTS.md's doc triggers follow it; check-docs.mjs reports long table cells and each file's size against HEAD, and the skill says to grep code comments that cite doc rows.
- Corrected along the way: the sync property's scenario count, PEAK_POOL_FILES, the perf fixture cache key, frontend_letters, the config table, the module map, which skipped ops are still a 400, GoodLinks status codes, /api/journal/cleanup's scope, the perf verdict table for timings, and several client-side claims.
- Two adversarial final reviews (server and client): no lost incidents; two lost rules restored; the wrong claims and pointers fixed. One code bug they found is filed as pkm-jvid.
