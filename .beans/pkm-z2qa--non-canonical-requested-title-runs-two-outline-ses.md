---
# pkm-z2qa
title: Non-canonical requested title runs two outline sessions; resync causality guard bypassed
status: todo
type: bug
priority: deferred
created_at: 2026-10-01T19:35:45Z
updated_at: 2026-10-01T19:44:13Z
---

A page opened under a non-canonical title runs two outline sessions: one for the loader, one for the editor. This happens on PageView via a URL like `/page/%20%20Paper%20%20` (from clicking a `[[  Paper  ]]` ref), and in a sidebar panel opened with such a title.

- `outline/useOutlinePageLoad.ts` acquires its session under the *requested* title: `acquireOutlineSession(title, null)`.
- `outline/useOutline.ts` acquires one under `pageTitle`. Since pkm-thee that is the payload's `CanonicalTitle`.
- So session `"  Paper  "` holds the page loader, the parent-read controller and the causality-guarded parent reads.
- Session `"Paper"` holds the editor, its local writes, and only the editable loader.

## Effect

The resync causality guard runs on a session that has never seen the local writes.

- The pkm-thee final review ran a copy of PageView's test "a parent resync response dispatched before a local split cannot erase it" under the padded URL.
  - Canonical URL: 3 fetches, including the corrective re-read.
  - Padded URL: 2 fetches. The stale tree is adopted through `useOutline`'s "initial prop changed" synthetic token.
- The split survived, because the delivered-write overlay held it. No visible loss was shown, but the guard's protection is bypassed.
- Likely also: `repairActiveOutlineSessions` repairs both sessions, doubling the GETs. This was not measured.

This predates pkm-thee on PageView. pkm-thee gave the sidebar the same shape, but also made the sidebar share the editor lease with a main pane open on the canonical title, which is an improvement.

## Fix direction

- Key the loader's session by the canonical title. Either re-key once the first payload lands (its `page.title` is canonical), or have `useOutlinePageLoad` hand its session to `EditablePage` instead of `EditablePage` re-acquiring one by title.
- Reproduce first: add the padded-URL variant of the resync-causality test, and assert the corrective re-read (the fetch count), not just the rows.

## Plan

- [ ] Reproduce: padded-URL resync-causality test asserting 3 fetches (red)
- [ ] One session per page, keyed by the canonical title
- [ ] Sidebar variant of the test
- [ ] Troubleshooting row if it reproduces
