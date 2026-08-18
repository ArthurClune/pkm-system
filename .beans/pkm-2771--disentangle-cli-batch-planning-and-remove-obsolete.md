---
# pkm-2771
title: Disentangle CLI batch planning and remove obsolete client and package boundaries
status: in-progress
type: task
priority: normal
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-17T20:55:21Z
parent: pkm-wvvu
---

## Review findings

Backend B1, B2, B3, the `cli/build.py` file-size finding, and the duplicated `_walk` helper.

`PkmClient.create_page` is production-dead and encourages non-atomic writes. `_Planner.creates()` mixes outline planning with batch-only alias/index bookkeeping. Shared planners and renderers live under `pkm.cli` despite use by client workflows and MCP.

## Acceptance criteria

- [x] Delete `PkmClient.create_page` and migrate test setup to atomic operation paths
- [x] Move batch-only uid/index/alias handling out of `_Planner.creates()` and introduce a small batch context only if it clarifies the threaded state
- [ ] Split batch schema/dispatch from the outline planner when doing so gives each module one clear job
- [ ] Relocate shared planning/rendering code to a transport-neutral package and update CLI, client workflow, and MCP imports
- [ ] Remove package-placement apology comments and deduplicate the tiny BlockNode walker
- [ ] Preserve CLI/MCP behavior, atomicity, help/contracts, and existing regression coverage
- [ ] Update backend architecture and import-direction tests
