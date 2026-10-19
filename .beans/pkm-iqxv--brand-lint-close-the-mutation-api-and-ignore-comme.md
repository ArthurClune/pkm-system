---
# pkm-iqxv
title: 'Brand lint: close the mutation-API and ignore-comment walk-arounds'
status: in-progress
type: task
priority: normal
created_at: 2026-10-19T09:09:49Z
updated_at: 2026-10-19T12:35:06Z
---

Found by the whole-branch review of feat/brand-check-web (pkm-zv2s phase 2). In test files these routes put an off-type value into a branded slot and pass both tsc and the lint (probed with the real eslint.config.js and the web tsconfig). Nothing in the tree uses them today; the branch removed the two that were.

## Cheap: one rule round (no-restricted-syntax or the brands plugin), each with a teeth fixture
- [x] `Reflect.apply(f, thisArg, args)`
- [x] `Object.defineProperty(obj, key, { value })`
- [x] `Object.assign(target, { <brand-named key>: ... })` (second argument has a key the name rule covers)
- [x] template-literal `import()` (`ImportExpression > TemplateLiteral`) of test-code modules from product code; also product import of `testDb` / `memReplica` (unreported today)

## Needs a design
- [ ] A value-carrying `@ts-expect-error` (`const u: BlockUid = "junk"` then used) vs a type probe; the R57 rule is a review convention today. Same question for non-brand exhaustiveness probes (retryPolicy, syncState tests).

## Document as known limits (TypeScript unsoundness)
- [x] computed-key spread `{ ...base, [field]: "junk" }` with `field: string`
- [x] method-shorthand bivariance (`interface H { m(x: string) }` implemented by `m(uid: BlockUid)`)
- [x] Record the limits in docs/architecture/enforced-checks.md beside the brand rules

## Server twin
- [x] brandlint's type-ignore matcher knows `# pyrefly: ignore` and `# type: ignore` but not `# pyright: ignore` (pyright is configured as a second opinion), so brand-launder and brand-ignore miss a launder under a pyright ignore

- [x] Same class as the ignored-return check (feat/brand-check-web fix wave): `self.x: Brand = ...` under an ignore, an untyped argument passed under `type: ignore[arg-type]`, a file-level `# pyrefly: ignore-errors` (pyrefly honours it) all lint clean.
- [x] Tidy the ignored-return check: it walks into nested functions (false positives / duplicate reports possible), and `_ignored_returns` repeats `_launderers` setup.

## Design ruling: @ts-expect-error (Arthur, 2026-10-19; settles R60)

A `@ts-expect-error` is allowed only inside `typeProbe(() => { ... })`, a test-helpers function that never calls its callback, so no probe runs. A test that deliberately feeds an off-type value to a runtime guard (the retryPolicy and syncState exhaustiveness tests) uses a named helper such as `offType<T>(v)`, which the lint treats as a declared junk mint. Codemod the existing sites (about 50).

- [ ] typeProbe + offType helpers, lint rule with teeth, codemod, docs
