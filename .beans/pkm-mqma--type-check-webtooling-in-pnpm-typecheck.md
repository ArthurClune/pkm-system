---
# pkm-mqma
title: Type-check web/tooling in pnpm typecheck
status: completed
type: task
priority: normal
created_at: 2026-10-19T17:40:04Z
updated_at: 2026-10-20T12:29:25Z
---

Nothing type-checks `web/tooling`: `pnpm typecheck` runs `tsc` over
`src` (and the apitypes config), not `tooling/tsconfig.json`. During
pkm-hc95 a brand narrowing in `tooling/perf/rebaseTargets.ts` left 11
TS2345 errors in its callers that every gate passed. `pnpm exec tsc -p
tooling/tsconfig.json --noEmit` also reports older errors (fcis-core.test.ts,
replica/db.ts as seen from tooling).

- [x] fix the existing tooling tsc errors
- [x] add `tsc -p tooling/tsconfig.json` to `pnpm typecheck` (so verify runs it)
- [x] note it in docs/architecture/enforced-checks.md

## Summary of Changes

- `pnpm typecheck` now also runs `tsc -p tooling/tsconfig.typecheck.json`.
  The new config extends the ESLint project `tooling/tsconfig.json` but
  excludes `tooling/eslint-fixtures`, whose violations are intentional (five
  of the nine errors). The console-guard fixtures type-check clean and stay in.
- `tooling/tsconfig.json` types are now `["node", "vite/client"]`:
  tooling imports `src/replica` modules that read `import.meta.env`.
- `fcis-core.test.ts` asserts with `toMatchObject` instead of property
  reads on an inferred union / nullable value.
- A planted type error in `tooling/buildBudgets.ts` fails `pnpm typecheck`.
- `enforced-checks.md` gains a `typecheck` row in the `pnpm verify` table.
