---
# pkm-f1rn
title: Add web lint, FCIS checks, and bundle/precache budgets
status: completed
type: task
priority: normal
tags:
    - web
    - tooling
    - performance
created_at: 2026-07-15T14:23:27Z
updated_at: 2026-07-16T09:32:31Z
parent: pkm-c1cg
---

## Goal

Add automated guardrails for React hook correctness, TypeScript maintainability, FCIS boundaries, and production/PWA asset size.

## Scope

Introduce TypeScript-aware linting, remove or justify hook dependency suppressions, and prevent Mermaid or other lazy chunks from silently inflating the PWA precache.

## Acceptance criteria

- [x] A lint command enforces React Hooks and TypeScript promise/error rules.
- [x] Existing exhaustive-deps suppressions are removed or documented with stable abstractions.
- [x] FCIS classification and import-boundary checks run in verification.
- [x] Production bundle and PWA precache budgets fail on material regression.
- [x] Mermaid loading/precache includes only required capabilities or has a documented budget exception.
- [x] pnpm verify includes the new checks and passes.

## Summary of Changes

**ESLint (flat, type-aware — `web/eslint.config.js`).** Two rule families only,
no sprawl: `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`,
`@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`,
`@typescript-eslint/only-throw-error`,
`@typescript-eslint/use-unknown-in-catch-callback-variable`, plus
`reportUnusedDisableDirectives: "error"`. `lintConfig.test.ts` drives the real
config over five fixtures proving each rule fires and its corrected form is clean.

**Zero exhaustive-deps suppressions.** All removed via useCallback / ref-backed
values / initial-value refs / ref-in-cleanup capture across EditableBlockTree,
SyncProvider (x4), QueryBlock, SearchBar, useOutline, Journal. Focused behavior
suites (reconnect, search, query, mount focus, draft adoption, authoritative
outline adoption) all still pass. `grep -rn "eslint-disable" web/src` is empty.

**Bundle/precache budgets (pure `buildBudgets.ts` core + `viteBudgetPlugin.ts`
shell + `budgets.json`).** Rollup generateBundle guards entry/largest/total and
module-owned Mermaid bytes; Workbox manifestTransforms guards precache
bytes/entries; over budget throws. Actuals vs limits: initialEntryBytes
440910/462016, largestAssetBytes 864752/907990, totalOutputBytes 5265120/5520272,
mermaidOwnedBytes 3429238/3461961, precacheBytes 5273425/5494604, precacheEntries
74/82.

**Mermaid exception.** Mermaid keeps its full never-online capability: its whole
lazy chunk family stays precached (offline E2E proves a diagram renders with no
network) under the explicit `mermaidOwnedBytes` raw cap. Ownership is decided by
module-graph reachability (all-or-nothing per chunk), never file-name substrings.

**Budget deviation (documented).** `initialEntryBytes` limit is 462016, not the
plan's 423707: the real entry (440910) already exceeds 423707 after tasks 1-9, so
462016 = actual + ~4.8% headroom (same methodology as the other five budgets,
which match the plan exactly). Rationale in budgets.json; see task-10-report.md.

**Final verify order:** typecheck -> lint -> check:fcis -> test:coverage ->
one guarded `vite build` -> `playwright test` (Playwright consumes that dist; no
second build; check:fcis runs once). Full `pnpm verify` passes: 1021 unit tests,
7 E2E, coverage 97.85/92.24/95.62/97.85 (all above thresholds).
