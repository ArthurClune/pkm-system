---
# pkm-ov19
title: Move react-router v6 to v7 for GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg
status: completed
type: task
priority: low
created_at: 2026-10-29T18:02:39Z
updated_at: 2026-10-29T18:02:39Z
---

pnpm audit --prod reports two moderate react-router v6 advisories that the v6 line does not fix (fixed in 7.18.0). They were judged unreachable here:

- GHSA-337j-9hxr-rhxg needs a data router or hydration data; the app mounts BrowserRouter with no data router and no SSR hydration.
- GHSA-wrjc-x8rr-h8h6 needs an attacker-controlled navigation target; every Link, NavLink, Navigate and navigate() target is pagePath() (always prefixed /page/, each segment encodeURIComponent-ed), a ROUTES constant, / or a #uid fragment.

The move needs the v7 package layout (react-router instead of react-router-dom), a check of every router import, the future-flag differences, and a re-run of the e2e suite for navigation and deep links.

- [x] Read the v6 to v7 upgrade notes and list breaking changes that touch the app
- [x] Upgrade and fix imports
- [x] pnpm audit --prod shows no react-router advisory
- [x] pnpm verify green

## Summary of Changes

react-router-dom 6.30.6 became react-router 7.18.5 (React 18 compatible); BrowserRouter and MemoryRouter semantics are unchanged, with no data router or framework mode. `pnpm audit --prod` reports no known vulnerabilities.

- Package rename: every import now comes from `react-router`.
- Future flags: `v7_startTransition` and `v7_relativeSplatPath` were already on and are the v7 behaviour, so `src/router.ts` and every `future={...}` prop are gone.
- `navigate()` now returns a promise, so each call site marks it `void` (lint's no-floating-promises and no-misused-promises).
- docs/SECURITY.md no longer lists the router advisories.
