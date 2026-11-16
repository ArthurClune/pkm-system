---
# pkm-3on7
title: Back/forward to a scrolled page lands at the top instead of where it was
status: completed
type: bug
priority: normal
created_at: 2026-11-16T15:45:40Z
updated_at: 2026-11-16T16:05:43Z
---

On a long page scrolled down, navigating to another page and then going back (or forward again) lands at the top of the page, not at the scroll position that history entry had. History traversal should restore each entry's viewport.

- [x] Reproduce in the running app and find the root cause
- [x] Failing test
- [x] Fix
- [x] Docs (frontend.md, navigation)
- [x] pnpm verify

## Summary of Changes

Symptom: back (or forward) to a long page the reader had scrolled lands at the top, or only sometimes at the right place.

Cause: the app relied on the browser's own scroll restoration, which applies the offset at popstate, before React renders the entry. PageView first renders "Loading…", which shrinks the document to one viewport and clamps the offset to 0; when the page arrives nothing re-applies it. Whether it worked depended on timing.

Fix: `useHistoryScrollRestore` (App) sets `history.scrollRestoration` to manual, records each entry's offset under its `history.state` key (minting one for the tab's first entry, which react-router leaves keyless as "default"), and on a POP re-applies the offset as the main pane grows until it holds for PIN_QUIET_MS or the reader scrolls. The outgoing offset is also recorded at popstate (capture), since a scroll event dispatched in the same frame as the back would otherwise be lost. Offsets survive a reload via sessionStorage. PageView skips its #uid jump when the entry restores an offset (`useRestoresHistoryScroll`). The entry chunk grows by about 2.4 KB; initialEntryBytes is rebaselined in its own commit.

Rule: docs/architecture/frontend.md § Scroll on back and forward.
