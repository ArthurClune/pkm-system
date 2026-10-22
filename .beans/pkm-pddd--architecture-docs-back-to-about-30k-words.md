---
# pkm-pddd
title: Architecture docs back to about 30k words
status: in-progress
type: epic
priority: normal
created_at: 2026-10-22T19:53:55Z
updated_at: 2026-10-22T20:11:19Z
---

docs/architecture/ grew from about 23k words (2026-09-23) to 65k, and docs/troubleshooting.md from 3k to 12k, in a month. Five reviews (scratchpad reports) found the growth comes from proof walk-throughs, hand-kept catalogues that copy the code, the same fact in several docs, and material appended in ship order. Aim: back to about 30k words in total without losing any invariant, its reason, or a must-not-break identifier. Rule for what stays: a doc states what the code and its checks cannot tell you.

## Checklist
- [x] Sync docs (pilot): sync-and-offline, sync-recovery, sqlite-wasm-patch; server facts move to backend.md
- [x] Arthur reviews the pilot's depth
- [ ] backend.md
- [ ] Frontend docs: frontend, frontend-editor, frontend-rendering, styling
- [ ] Gate docs: performance-checks, property-checks, enforced-checks become one checks.md; catalogues move beside the code
- [ ] Smaller docs: overview, assistant, cli-and-mcp, files-and-assets (goodlinks folds in), import-export-and-backup
- [ ] docs/troubleshooting.md: fixed-form Cause column, refile misfiled rows, subgroup Sync and Backend
- [ ] Stop the regrowth: AGENTS.md § Architecture docs, architecture-docs skill, check-docs.mjs reports long table cells
- [ ] Fix the factual errors the reviews found
- [ ] Whole-branch review on the strongest model; check-docs passes
