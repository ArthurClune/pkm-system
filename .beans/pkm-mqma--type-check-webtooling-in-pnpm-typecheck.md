---
# pkm-mqma
title: Type-check web/tooling in pnpm typecheck
status: todo
type: task
priority: normal
created_at: 2026-10-19T17:40:04Z
updated_at: 2026-10-19T17:40:04Z
---

Nothing type-checks `web/tooling`: `pnpm typecheck` runs `tsc` over
`src` (and the apitypes config), not `tooling/tsconfig.json`. During
pkm-hc95 a brand narrowing in `tooling/perf/rebaseTargets.ts` left 11
TS2345 errors in its callers that every gate passed. `pnpm exec tsc -p
tooling/tsconfig.json --noEmit` also reports older errors (fcis-core.test.ts,
replica/db.ts as seen from tooling).

- [ ] fix the existing tooling tsc errors
- [ ] add `tsc -p tooling/tsconfig.json` to `pnpm typecheck` (so verify runs it)
- [ ] note it in docs/architecture/enforced-checks.md
