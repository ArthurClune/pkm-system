---
# pkm-mpke
title: Focused line editing flashes offline banner
status: in-progress
type: bug
priority: high
created_at: 2026-07-14T21:10:23Z
updated_at: 2026-07-14T21:16:28Z
---

Editing a focused line repeatedly flashes the Connection lost/offline banner after the recent edit-revert fixes.

- [x] Reproduce and identify the root cause
- [x] Add a regression test that fails before the fix
- [x] Implement the minimal root-cause fix
- [x] Run focused and full verification
- [ ] Commit, push, and summarize the fix

## Root Cause

The socket stays connected. Each debounced text edit briefly changes the durable queue count from 0 to 1 and back to 0. OfflineIndicator renders its connected/pending state as a top-level syncing banner even though no reconnect occurred, causing an 8–15 ms flash for every edit.
