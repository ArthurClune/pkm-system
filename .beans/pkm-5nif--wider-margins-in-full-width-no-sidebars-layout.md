---
# pkm-5nif
title: Wider margins in full-width (no sidebars) layout
status: completed
type: task
created_at: 2026-07-25T12:02:10Z
updated_at: 2026-07-25T13:16:00Z
---

Follow-up to pkm-57mo: when both sidebars are gone (.app.nav-collapsed.no-sidebar) the center pane should keep slightly wider side margins than the current 96px total gutter / 1320px cap.

## Summary of Changes

- `web/src/styles.css`: `.app.nav-collapsed.no-sidebar .content-area` (the
  both-sidebars-gone case) now uses `--pane-width: min(1240px, calc(100% -
  160px))`, up from `min(1320px, calc(100% - 96px))` — total side gutter
  96px -> 160px, cap trimmed 1320px -> 1240px, per the bean's suggested
  numbers. The other three sidebar combinations (both open, left-collapsed-
  only, right-absent-only) are untouched.
- `web/src/styles.test.ts`: added a `describe("full-width layout margins
  (pkm-5nif)")` assertion pinning the new `min(1240px, calc(100% -
  160px))` value on that selector, following the file's existing
  `ruleFor()`-based pattern.
- `web/e2e/page-width.spec.ts` needed no changes: it only asserts strict
  monotonic widening across the four sidebar combinations (not exact pixel
  values), and that property still holds with the new numbers — verified
  by rerunning the spec.

## Verification

`cd web && E2E_PORT=8976 pnpm verify` — clean pass: `tsc`, `eslint`,
`check:fcis`, 1445/1445 unit tests (incl. new styles.test.ts case), `vite
build` (precache budget OK), 34/34 Playwright e2e (incl.
`page-width.spec.ts`). Two runs under heavy parallel-session load on this
machine (`uptime` load average briefly 18-23 on a 10-core box) surfaced
`e2e/backlink-filter.spec.ts` and `tooling/lintConfig.test.ts` timeouts —
both pre-listed known flakes, neither touching styles.css/page-width, and
both passed cleanly once load eased. Not merged to main; not deployed.
