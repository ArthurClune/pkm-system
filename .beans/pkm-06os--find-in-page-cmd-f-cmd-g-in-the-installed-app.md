---
# pkm-06os
title: Find in page (Cmd-F / Cmd-G) in the installed app
status: in-progress
type: feature
priority: normal
created_at: 2026-11-14T14:50:01Z
updated_at: 2026-11-14T14:53:17Z
---

In the installed PWA (display-mode: standalone) Cmd-F and Cmd-G do nothing, since there is no browser chrome to provide find. Add an in-app find bar that only takes the keys in standalone mode.


Spec: docs/superpowers/specs/2026-11-14-pwa-find-in-page-design.md
Plan: docs/superpowers/plans/2026-11-14-pwa-find-in-page.md

- [ ] Pure matcher (findMatches.ts)
- [ ] Page text shell (pageText.ts)
- [ ] FindBar, App wiring, styles, docs
- [ ] E2E spec and pnpm verify
