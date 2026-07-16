---
# pkm-23dd
title: Verification output hygiene
status: todo
type: task
created_at: 2026-07-16T12:08:59Z
updated_at: 2026-07-16T12:08:59Z
---

Practical diagnostics triaged by the pkm-c1cg final review as worth silencing (the SQLite FK diagnostic and Node experimental localStorage warning were triaged ACCEPT as intrinsic):

- [ ] Add a catch-all route to the TopBar test render (TopBar.test.tsx ~line 170) to silence the unmatched /current-work route message.
- [ ] Set build.chunkSizeWarningLimit now that hard byte budgets supersede Vite's advisory warning.
- [ ] Fix the Playwright NO_COLOR / FORCE_COLOR env conflict warning.
