---
# pkm-d5re
title: Surface page deletion failures in TopBar
status: completed
type: bug
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-18T16:32:05Z
parent: pkm-wvvu
---

## Review finding

Frontend correctness-adjacent flag: a confirmed page deletion that fails is swallowed, the menu closes, and the user receives no indication that the page remains.

## Acceptance criteria

- [x] Keep the failed page visible and surface an actionable deletion error through TopBar or the confirmation flow
- [x] Clear or supersede stale errors on a later attempt/navigation as appropriate
- [x] Preserve successful deletion navigation and menu behavior
- [x] Add component coverage for success, failure, retry, and accessible error announcement
- [x] Reuse an existing application error pattern rather than inventing a second notification system


## Summary of Changes

`TopBar.handleDelete` previously swallowed a failed DELETE (`catch { deleted = false }`)
with no user-visible trace. Now:

- A `deleteError` state holds the message; on failure the menu still closes
  (unchanged behavior) but the error is set instead of discarded, and the
  function returns before navigating -- the page stays put.
- On success the code path is unconditional again (no more `deleted` flag):
  close the menu, navigate to `/`.
- The error is cleared at the start of every new delete attempt (so a retry
  never shows a stale message) and on any route change (so navigating away
  from the page doesn't leave an error hanging for a page no longer open).
- Rendered as `<p className="error upload-error top-bar-error" role="alert">`
  with a Dismiss button -- the same dismissible-inline-error convention
  EditablePage's upload-error uses (and the same `role="alert"` OfflineIndicator
  uses), formatted with `String(e)` the way PageTitle already does. No new
  notification mechanism.
- New `.top-bar-error` CSS rule (plus its mobile override) aligns the banner
  under `.top-bar` in the `.content-area` column instead of stretching edge
  to edge.

Tests added to `TopBar.test.tsx`: failure now asserts a `role="alert"` with
the page title and underlying error text; a dismiss test; a retry test
(fail then succeed, confirms the stale error clears and navigation still
fires); a navigate-away-clears-stale-error test using a real route change
inside the same router instance.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (2091 tests),
and the full `CI=true E2E_PORT=8983 pnpm verify` gate (typecheck + lint +
FCIS + coverage-enforced unit tests + build + Playwright, 53 E2E tests) all
green. TopBar.tsx coverage: 100% statements/lines, 96.87% branches (the one
uncovered branch, line 45's `if (title === null) return`, predates this
change and is unreachable by construction -- the delete menu item only
renders when `title !== null`). One `tooling/lintConfig.test.ts` timeout was
observed on a loaded machine during a back-to-back verify run; it passed in
isolation (910ms) and on a clean re-run of the full gate -- an unrelated,
previously-documented load-sensitive flake, not touched by this change.

No architecture doc update: this is a localized error-surfacing fix, not a
new documented boundary.
