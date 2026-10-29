---
# pkm-ov19
title: Move react-router v6 to v7 for GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg
status: todo
type: task
priority: low
created_at: 2026-10-29T18:02:39Z
updated_at: 2026-10-29T18:02:39Z
---

pnpm audit --prod reports two moderate react-router v6 advisories that the v6 line does not fix (fixed in 7.18.0). They were judged unreachable here:

- GHSA-337j-9hxr-rhxg needs a data router or hydration data; the app mounts BrowserRouter with no data router and no SSR hydration.
- GHSA-wrjc-x8rr-h8h6 needs an attacker-controlled navigation target; every Link, NavLink, Navigate and navigate() target is pagePath() (always prefixed /page/, each segment encodeURIComponent-ed), a ROUTES constant, / or a #uid fragment.

The move needs the v7 package layout (react-router instead of react-router-dom), a check of every router import, the future-flag differences, and a re-run of the e2e suite for navigation and deep links.

- [ ] Read the v6 to v7 upgrade notes and list breaking changes that touch the app
- [ ] Upgrade and fix imports
- [ ] pnpm audit --prod shows no react-router advisory
- [ ] pnpm verify green
