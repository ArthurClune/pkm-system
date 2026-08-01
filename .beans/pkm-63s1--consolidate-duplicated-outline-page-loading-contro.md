---
# pkm-63s1
title: Consolidate duplicated outline page-loading controllers
status: completed
type: task
created_at: 2026-08-01T13:20:53Z
updated_at: 2026-08-01T14:40:00Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 6.

**References:** web/src/views/PageView.tsx:46-139; web/src/components/EditableSidebarPanel.tsx:40-105

Both modules independently coordinate request generations, ReadToken, ParentReadiness, cancellation, session acceptance, loader/controller registration, errors, and cleanup. They already differ: PageView treats missing daily pages as editable empty pages while the sidebar reports an error for the same page.

**Direction:** Extract one shell-level outline-loading controller/hook with an explicit missing-page policy. Keep main-pane/sidebar differences limited to presentation and scoped scrolling.

- [x] Specify shared loading lifecycle and daily-page behavior
- [x] Add parity tests for main-pane and sidebar daily pages
- [x] Replace the duplicate controllers

## Summary of Changes

One controller now: `web/src/outline/useOutlinePageLoad.ts` (shell) owns the
whole read lifecycle for every surface showing an editable page outline, and
its doc comment is the written-down spec — states, the events that start a
read, and the generation/cancellation/cleanup orderings the two copies used
to implement separately. It returns `{payload, error, reload}`; both state
writes are keyed by the title they were requested for.

`web/src/outline/missingPage.ts` (core) holds the missing-page policy as a
`(title, status) => PagePayload | null` function, passed explicitly by both
consumers as `substituteMissingDaily`. It takes the HTTP status rather than
the error object so a Functional Core module never imports the shell's
`ApiError` (enforced by `pnpm check:fcis`).

Behaviour change, as directed by the brief: a missing daily page is now an
empty editable outline in the **sidebar** too, not an error — matching the
main pane. Parity tests in `EditableSidebarPanel.test.tsx` render the same
missing-daily fixture through `PageView` and through the panel and assert
both show an editable empty outline with no error.

Two smaller unifications fell out of merging the copies:

- a substituted missing page is now delivered through the same path as a real
  response, generation check included, instead of its own shorter branch. The
  old copy could not actually publish behind a superseded read (the session
  rejects a superseded token) and did not leak anything: `load()` releases the
  previous read's parent readiness as it supersedes it. This is symmetry —
  one delivery path for every settled response — not a bug fix;
- the sidebar now resets to Loading on a title change instead of keeping the
  previous title's payload in state, and `PageView` gained the sidebar's
  render-time title key, so neither can paint a payload under a title it
  was not fetched for.

`PageView` keeps the resync wiring (`reload("resync")` on a `resyncSeq`
bump); the sidebar does not subscribe to resync, as before.

Verified: `pnpm test:unit` (1752 tests, 115 files), `pnpm typecheck`,
`pnpm lint`, `pnpm check:fcis`, `pnpm test:coverage` (thresholds pass; every
line left uncovered in the new hook was uncovered in the old PageView
controller too — checked against a stashed baseline). Docs: the
`outline/` module map entry and a new prose note in
`docs/architecture/frontend.md` § State management.
