---
# pkm-pe79
title: delete page in ipad fails
status: completed
type: bug
priority: normal
created_at: 2026-07-23T19:54:24Z
updated_at: 2026-07-23T20:24:39Z
---

delete page on ipad fails - 'are you sure' pop up doesn't show so operation stops

## Summary of Changes

Root cause: `TopBar.tsx`'s page-delete handler gated the destructive
DELETE request on `window.confirm(...)`. iPadOS Safari suppresses
`window.confirm`/`window.alert` while the app runs standalone (added to
home screen / installed as a PWA): the call returns `false` immediately
without ever showing anything, so the delete silently no-oped on iPad --
exactly the reported symptom.

Fix: added `web/src/components/ConfirmDialog.tsx`, a `useConfirm()` hook
that renders an accessible, portal-based in-app confirm dialog
(`role="alertdialog"`) and resolves a promise `confirm(message, options)`
the same shape `window.confirm` used to provide
(`if (!(await confirm(...))) return;`), but one that works in standalone
mode everywhere. Escape/backdrop-click/Cancel resolve `false`; Enter or
the confirm button resolve `true`; the confirm button auto-focuses for
keyboard-first use. Styled with the existing `--radius-*`/`--color-*`
tokens plus a new `.btn-danger` for destructive actions.

Applied to:
- `web/src/components/TopBar.tsx` -- page delete (the reported bug).
- `web/src/components/PageTitle.tsx` -- rename-onto-existing-title merge
  confirm (same single-component async-handler pattern, trivial to
  convert, same dialog reused).

Other `window.confirm` usage found but NOT converted (different pattern --
a keyboard handler inside the `useOutline` hook, which doesn't render JSX
itself; wiring an async dialog through to `EditablePage` is a larger,
separately-scoped change with more regression risk to the already-shipped
pkm-q89w multi-block-delete feature):
- `web/src/outline/useOutline.ts:381` -- `onDeleteBlockSelection`,
  confirming a multi-block delete (Backspace/Delete on a large selection).
  Recommend a follow-up bean if this also needs to work on iPad (block
  selection multi-delete is a desktop-keyboard-first flow today).

Tests (TDD): unit tests for the new dialog
(`ConfirmDialog.test.tsx`), updated `TopBar.test.tsx` and
`PageTitle.test.tsx` to exercise the in-app dialog instead of stubbing
`window.confirm`, a new Playwright spec `e2e/delete-page.spec.ts`
(dialog appears naming the page, cancel/Escape leave the page intact,
confirm deletes and navigates home -- exercisable headlessly since it no
longer depends on native `confirm()`), and updated `e2e/rename.spec.ts`'s
merge test to click the in-app dialog instead of `page.on("dialog")`.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis`,
`pnpm test:coverage` (1421 tests) all green; `pnpm build` + full
Playwright suite (31 specs) green on a clean run. Some unrelated e2e specs
(`wrapped-arrow.spec.ts`, `backlink-filter.spec.ts`, `edit.spec.ts`,
`lintConfig.test.ts`) flaked intermittently across repeated full-suite
runs under heavy concurrent system load (other agent sessions'
Playwright/pytest runs sharing the machine, load average ~3.5-6.8); each
failure was a different, unrelated spec, and none touch
TopBar/PageTitle/ConfirmDialog. The new/changed specs
(`delete-page.spec.ts`, `rename.spec.ts`) and unit tests
(`ConfirmDialog.test.tsx`, `TopBar.test.tsx`, `PageTitle.test.tsx`) passed
on every repeated run.
