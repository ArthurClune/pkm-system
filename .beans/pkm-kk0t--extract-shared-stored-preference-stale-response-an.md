---
# pkm-kk0t
title: Extract shared stored-preference stale-response and flash-target hooks
status: todo
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-17T20:55:24Z
parent: pkm-wvvu
---

## Review findings

Frontend A6 systematic React-idiom duplication.

## Acceptance criteria

- [ ] Add a typed `useStoredPref(key, guard, fallback)` and migrate theme, sidebar-collapse, and block-stamp preferences
- [ ] Add a stale-response token helper whose cancellation/bump semantics are explicit, then migrate consumers where the lifecycle truly matches
- [ ] Add a shared scroll-and-flash target hook for main-page and sidebar roots
- [ ] Preserve storage failure fallbacks, StrictMode behavior, response supersession, scoped selectors, cleanup timers, and hash navigation
- [ ] Avoid forcing Files generation/query-key behavior through the hook if its contract is materially different
- [ ] Add focused hook and migrated-consumer tests
