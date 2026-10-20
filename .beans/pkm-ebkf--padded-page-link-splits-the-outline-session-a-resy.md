---
# pkm-ebkf
title: Padded page link splits the outline session; a resync can erase a remote edit
status: completed
type: bug
priority: high
created_at: 2026-10-19T15:59:04Z
updated_at: 2026-10-20T10:00:31Z
---

## Symptom

Open a page through a padded link (`[[ Foo ]]`, `[[Foo ]]`) or a URL with
a trailing space or `%09`, in the main pane or a shift-click sidebar. A
remote edit (or a just-delivered local one) can then vanish from the
outline when a resync answer races it, and stays gone until the next
reload, resync or remote batch.

## Cause

`useOutlinePageLoad` acquires its outline session under the requested
title (`titleFromPathname` only percent-decodes; `openInSidebar` passes a
ref's normalized title), while `useOutline`, `Journal`, undo and tracked
writes key by the canonical `payload.page.title`. Under the plain-space
flag `/page/Foo%20` resolves to page `Foo`, so two sessions exist. The
loader session never sees remote batches or tracked writes, so its
revision never advances and `receiveParentAuthoritative` always accepts a
stale response; `PageView` republishes it as `initial`, and `useOutline`'s
fallback effect adopts it under a freshly minted token, losing the
causality check (the comment above that effect warns of exactly this).

Sequence: remote R1; resync GET dispatched; remote R2 shows; GET answers
with R1 but not R2 -> R2 disappears, no follow-up fetch.

## Repro

A PageView vitest over `/page/Paper` (control), `/page/Paper%09`,
`/page/Paper%20`: (a) `isOutlineSessionActive` is true for both the raw and
canonical keys; (b) the resync race above loses "remote two". Control
passes both. Written during the pkm-hc95 survey (2026-10-19); the test file is kept,
uncommitted, in docs/superpowers/handoffs/title-bug-repros/.

## Fix direction

Key `useOutlinePageLoad`'s session by the canonical title (the replica
`canonicalTitle(db, requested)` the read already computes).
`EditableSidebarPanel`'s header comment already says the outline must use
the payload title. Not affected: undo history, double replay, first
render.

- [x] failing test (both checks above, `%09` and `%20`)
- [x] key the session canonically
- [x] troubleshooting.md row

## Summary of Changes

useOutlinePageLoad keyed its outline session by the requested title. The main thread cannot canonicalize a title (the plain-space flag lives in the replica worker), so the hook now keeps the requested title only until an accepted read names a different page title. It then re-keys once: it releases the raw session, acquires the canonical one, and reads afresh under it. It never seeds the canonical session with the payload already in hand. A non-canonical title costs one extra GET. Tests: the PageView session-key repro (%09, %20 and a control), hook tests for padded, canonical, resync-before-first-answer, rename-race and missing-daily cases, and an EditableSidebarPanel test. There is a troubleshooting.md row, and frontend-editor.md now describes the loader's keying. The web verify gate and perf (frontend: no change) pass.
