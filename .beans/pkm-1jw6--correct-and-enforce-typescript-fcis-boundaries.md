---
# pkm-1jw6
title: Correct and enforce TypeScript FCIS boundaries
status: completed
type: task
priority: high
tags:
    - web
    - fcis
    - architecture
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-16T10:30:00Z
parent: pkm-c1cg
---

## Problem

Several files labelled Functional Core perform browser I/O, React state/context work, navigation, randomness, or message-port I/O. Core modules can also import Imperative Shell components.

## Scope

Audit runtime classifications, split pure decisions from behavioral wrappers where useful, and automate boundary enforcement.

## Acceptance criteria

- [x] rpc.ts, uid.ts, contexts.ts, BlockRef, AssetImage, PageLink, TodoCheckbox, InlineSegments, and comparable files are correctly classified or split.
- [x] Functional Core modules do not import Imperative Shell modules.
- [x] Nondeterministic values such as UIDs are gathered in shells or passed into pure functions.
- [x] A repository check enforces required pattern comments and core-to-shell import boundaries.
- [x] Intentional exceptions are documented using the FCIS unavoidable format.
- [x] The check runs in pnpm verify.
- [x] pnpm verify passes.

## Summary of Changes

Added a real checker (`web/tooling/fcis-core.mjs` pure policy + `web/tooling/fcis.mjs`
thin shell) that scans every runtime `web/src/**/*.{ts,tsx}` module (excluding
`*.test.*` and `*.d.ts`), requires a `// pattern: ...` header in the first five
lines (missing/late/duplicate/unknown all fail), and walks each file's AST via
the TypeScript compiler API to find relative import/export/dynamic-import
edges. Any edge from a module classified Functional Core to one classified
Imperative Shell or Mixed fails, unless the edge is type-only (fully erased at
runtime). Exact-path exemptions (non-empty reason required) opt a handful of
non-runtime-behaviour files out of the header requirement entirely. Wired as
`check:fcis` in `web/package.json`, running in `verify` right after
`typecheck` and before `test:coverage`.

Extracted `web/src/uidCore.ts` (Functional Core: the pure byte->alphabet
mapping) out of `web/src/uid.ts`, which stays the Imperative Shell that calls
`crypto.getRandomValues` and hands the bytes to the pure core. Relabelled
`contexts.ts`, `BlockRef.tsx`, `AssetImage.tsx`, `PageLink.tsx`,
`TodoCheckbox.tsx`, `ErrorBoundary.tsx`, and `InlineSegments.tsx` from
Functional Core to Imperative Shell -- each does real React
state/effect/context/navigation work (or, for InlineSegments, composes
several such shells), not a pure rendering decision. `replica/rpc.ts` was
already correctly labelled Imperative Shell; no change needed there.

### Exemption table (`web/tooling/fcis-exemptions.json`)

| Path | Reason |
|---|---|
| `src/api/ops.ts` | Type-only aliases over generated OpenAPI schema -- no runtime declarations. |
| `src/api/payloads.ts` | Type-only re-exports of generated OpenAPI response shapes -- no runtime declarations. |
| `src/router.ts` | Static React Router future-flag constants -- a config value, not FCIS logic. |
| `src/replica/baseSchema.gen.ts` | Generated SQL DDL string constant (server schema_dump.py) -- data, not hand-written logic. |
| `src/replica/testDb.ts` | Test-only in-memory sqlite-wasm helper, excluded from coverage the same as test files. |
| `src/test-helpers.ts` | Shared test fixtures/mocks used only by `*.test.ts` files. |
| `src/test-setup.ts` | Vitest global setup, excluded from coverage. |

All five non-type-only exemptions map onto CLAUDE.md's own "Tests,
type-only/constants files, configs, scripts, and data files are exempt"
carve-out -- none hide a real Functional-Core-to-Shell edge; `pnpm check:fcis`
reports zero forbidden edges with these in place.

### Final boundary audit

`pnpm check:fcis` classifies 101 runtime modules (39 Functional Core, 62
Imperative Shell, 0 Mixed) with zero forbidden core->shell/mixed edges. The
Task 7/8 pure cores (`outline/keyboardPolicy.ts`, `sync/queueState.ts`,
`sync/syncState.ts`, `grammar/scan.ts`, `grammar/refs.ts`, `grammar/todo.ts`,
`outline/refAtCaret.ts`, `replica/refs.ts`) were re-audited: all import only
each other or type-only symbols from Shell modules (e.g. `syncState.ts`'s
`import type { PoisonEvent } from "./opQueue"`), so none needed relabelling --
their purity holds.
