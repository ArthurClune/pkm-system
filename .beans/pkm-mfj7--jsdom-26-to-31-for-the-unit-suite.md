---
# pkm-mfj7
title: jsdom 26 to 31 for the unit suite
status: completed
type: task
priority: normal
created_at: 2026-11-17T21:46:56Z
updated_at: 2026-11-17T21:54:54Z
parent: pkm-tcca
---

Part of pkm-tcca. Bump jsdom (devDependency, vitest environment) from ^26.1.0 to 31.

- [x] Bump jsdom and install in the worktree
- [x] pnpm verify green
- [x] Note any behaviour change the tests relied on

## Summary of Changes

jsdom ^26.1.0 to ^31.0.1 (devDependency; the vitest environment only). No test
or source change was needed: 7160 unit tests and 130 Playwright specs pass.
The only observable difference is less stderr noise: jsdom 31 no longer
reports a thrown render error as an extra `Error: Uncaught` alongside React's
own report (ErrorBoundary.test.tsx). jsdom 31 needs Node ^22.22.2, ^24.15 or
>=26.
