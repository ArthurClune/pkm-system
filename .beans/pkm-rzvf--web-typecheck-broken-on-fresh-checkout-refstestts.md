---
# pkm-rzvf
title: 'web typecheck broken on fresh checkout: refs.test.ts imports node:fs without @types/node'
status: completed
type: bug
priority: high
created_at: 2026-07-12T18:49:07Z
updated_at: 2026-07-12T19:23:36Z
---

cd web && pnpm typecheck fails on a pristine install of main since bb14974 (pkm-c3kz merge): src/grammar/refs.test.ts(6) imports node:fs but @types/node is not a declared devDependency, so TS2307. Passes only in checkouts whose node_modules happens to contain @types/node transitively/stale. Fix: add @types/node to web devDependencies (or drop the node:fs import from the test). Found during pkm-dnl6 merge verification on 2026-07-12; failure reproduced on pristine bb14974, so not caused by the sync merge (7c26e54).

## Summary of Changes

Declared `@types/node` as a direct web devDependency and refreshed the pnpm lockfile, so the intentional `node:fs` import in `src/grammar/refs.test.ts` resolves on pristine installs. Reproduced TS2307 in an external clean worktree before the change, then verified typecheck and all 419 web tests after the fix.
