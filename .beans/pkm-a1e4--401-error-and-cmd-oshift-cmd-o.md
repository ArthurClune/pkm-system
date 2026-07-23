---
# pkm-a1e4
title: 401 error and cmd-o/shift-cmd-o
status: completed
type: bug
priority: normal
created_at: 2026-07-23T15:32:49Z
updated_at: 2026-07-23T20:31:00Z
---

Within a block cmd-o opens a page reference and cmd-shift-o open it in the sidebar. If however the page hasn't been created yet, then this gives a 401 error as the page is created when the cursor leaves the [[]] tags. cmd-o/cmd-shift-o should create the page if it doesn't exist before jumping to it

## Summary of Changes

Root cause: the shipped shortcut (pkm-ul9u) is actually **Ctrl-O**, not
Cmd-O (Cmd is deliberately excluded — Cmd-O is the OS-reserved "open file"
shortcut). There was also no Shift variant at all yet — Ctrl-Shift-O simply
fell through the same `navigate-ref` branch as plain Ctrl-O (no sidebar
behaviour existed). Investigated the reported "401": reproduced directly
against the FastAPI test app (`TestClient`) and confirmed `GET
/api/page/{missing title}` returns a clean **404** ("page not found"),
never 401 — `require_auth` runs router-wide and is unaffected by whether the
page exists. The user-visible symptom is the `PageView`/`EditableSidebarPanel`
error state rendered from that 404 ("Could not load … 404 …"), not an actual
401 from the server. The real bug: a reference typed this session whose caret
never left the `[[...]]` token has its autosave flush *held*
(`holdsDraftFlush`, pkm-xlah) specifically so the half-typed title isn't
materialised as a page — meaning the target genuinely has no row yet when
Ctrl-O/Ctrl-Shift-O fires, and `get_or_create_page` (which every *flushed*
ref triggers via `ops_apply.py`) never ran for it.

Fix:
- `web/src/outline/keyboardPolicy.ts`: `navigate-ref` decision now carries a
  `sidebar: boolean` (`= shiftKey`), so Ctrl-Shift-O over the same ref opens
  it in the sidebar instead of navigating the main pane, mirroring
  shift-click on a rendered `PageLink`.
- `web/src/components/EditableBlockTree.tsx`: before acting on `navigate-ref`,
  unconditionally POSTs `/api/pages` (idempotent — `create_page`'s docstring:
  "creating an existing page returns its row, not an error") and only then
  navigates or calls `openInSidebar`, the same create-then-go sequence
  `SearchBar`'s "Create page" row already uses. Best-effort: a failed POST
  still falls through to navigate/open as before.
- Tests: extended `keyboardPolicy.test.ts` and `EditableBlockTree.test.tsx`
  (create-then-navigate, create-then-sidebar-open, TDD red/green verified by
  temporarily reverting the fix). Added `web/e2e/ref-open.spec.ts`: two new
  Playwright specs that type an un-flushed `[[ref]]` via the real bracket
  auto-pair, confirm the target 404s server-side beforehand, then press
  Ctrl-O / Ctrl-Shift-O and assert the page now exists and is opened
  correctly (main pane / sidebar respectively). Both pages are created via
  POST with unique timestamped titles — no journal/daily writes.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis`,
`pnpm test:coverage` (98 files / 1415 unit tests) all green; `pnpm verify`'s
Playwright stage is noisy on this machine — `e2e/backlink-filter.spec.ts` and
(separately) `e2e/edit.spec.ts` each intermittently timed out on unrelated
rapid keypress sequences, reproduced identically with this fix fully
`git stash`ed (pristine code), confirming a pre-existing, unrelated
environment flake, not a regression. The new `ref-open.spec.ts` tests and
the rest of the suite passed cleanly (29/29) on a follow-up clean run.
No server/ changes were needed (the auth/404 behaviour was already correct).
