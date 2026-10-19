---
# pkm-iqxv
title: 'Brand lint: close the mutation-API and ignore-comment walk-arounds'
status: completed
type: task
priority: normal
created_at: 2026-10-19T09:09:49Z
updated_at: 2026-10-19T13:40:00Z
---

Found by the whole-branch review of feat/brand-check-web (pkm-zv2s phase 2). In test files these routes put an off-type value into a branded slot and pass both tsc and the lint (probed with the real eslint.config.js and the web tsconfig). Nothing in the tree uses them today; the branch removed the two that were.

## Cheap: one rule round (no-restricted-syntax or the brands plugin), each with a teeth fixture
- [x] `Reflect.apply(f, thisArg, args)`
- [x] `Object.defineProperty(obj, key, { value })`
- [x] `Object.assign(target, { <brand-named key>: ... })` (second argument has a key the name rule covers)
- [x] template-literal `import()` (`ImportExpression > TemplateLiteral`) of test-code modules from product code; also product import of `testDb` / `memReplica` (unreported today)

## Needs a design
- [x] A value-carrying `@ts-expect-error` (`const u: BlockUid = "junk"` then used) vs a type probe; the R57 rule is a review convention today. Same question for non-brand exhaustiveness probes (retryPolicy, syncState tests).

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

- [x] typeProbe + offType helpers, lint rule with teeth, codemod, docs

## Summary of Changes

- Web lint `brands/no-brand-bypass`: reports `Reflect.apply`/`construct`; brand-named writes through `Object.assign` (sources judged by type), `defineProperty`/`defineProperties`, `Reflect.defineProperty`/`set` whose value isn't already the brand; and any alias of these (destructuring, `globalThis`, `g.Object`). Test-fixture modules (`testDb`, `memReplica`) are banned from product code, template-literal `import()` included. TypeScript limits are documented.
- Server brandlint: recognises `# pyright: ignore`; catches `self.x: Brand` under an ignore and unchecked keyword values (only the brand's helper, malformed helper or constructor at a mint site are vouched); new `brand-file-ignore` (pyrefly ignore-errors, pyright basic and severity downgrades, a top-of-file type: ignore); a return belongs to its innermost function; shared setup is factored.
- `@ts-expect-error` (settles R60): allowed only inside `typeProbe(() => {...})` from test-helpers, which never runs its body (`brands/ts-expect-error-in-probe`). Runtime-guard tests use `offType<T>(v)`, the one declared junk route, which may not carry junk into a brand slot (the shallow T check plus an argument walk; branded junk goes through the `malformed*` helpers). All 58 sites are migrated.
- commentlint covers the web root's config files.
