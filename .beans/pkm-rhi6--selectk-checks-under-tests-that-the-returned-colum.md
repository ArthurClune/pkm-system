---
# pkm-rhi6
title: select<K> checks under tests that the returned columns cover K
status: completed
type: task
priority: normal
created_at: 2026-10-19T09:13:28Z
updated_at: 2026-10-19T13:15:26Z
---

Split from pkm-78r0 (its Optional item).

`select<K>` is type-only: a K naming a column the SQL does not return types it as present. Under tests, check that the returned columns cover K (needs the keys at runtime, e.g. a keys argument). Medium cost: ~130 call sites.

- [x] Decide the runtime key check and its call-site shape
- [x] Migrate the call sites

## Design (Arthur, 2026-10-19)

`select(sql, keys, params?)`: sql first and params last, as in `exec` and `introspect`. `K` is inferred from a required, non-empty `keys` array, so the keys exist once, as values. Under test, the engine's column names (empty results too) must equal the keys exactly. Production ignores `keys`. Lint: the keys argument is an array literal of string literals, so it cannot be widened (`const ks: (keyof Columns)[]` would type every column as present).

- [x] Lint rule: select's keys argument is an array literal of string literals, with teeth
- [x] Docs

## Summary of Changes

- `ReplicaDb.select(sql, keys, params?)`: `K` is inferred from a required, non-empty keys array. Under test, the engine's column names (empty results too) must equal the keys exactly (`keyColumnsMessage` in rowCheck.ts). Production is unchanged and ignores the keys.
- About 200 call sites in 38 files were codemodded. No wrong K was found. `parkTakenTitles` now branches per table, and two tests' unregistered aliases were fixed.
- Lint `brands/select-keys-literal` (type-aware, ReplicaDb only): keys must be an array literal of string literals, or a generic K forwarded inside a `select` implementation. Spread arguments and computed callees are reported. Teeth in lintConfig.test.ts.
- Docs: frontend.md (Replica database access), enforced-checks.md.
- Gates on the branch: pnpm verify (3918 unit, 81 e2e), proptest web (77), perf frontend (no regression; two K `faster` timings left unrecorded).
