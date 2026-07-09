---
# pkm-862c
title: 'Main scroll: June 30 2026 daily note shows block IDs instead of content'
status: completed
type: bug
priority: normal
created_at: 2026-07-09T18:54:25Z
updated_at: 2026-07-09T19:37:32Z
---

In the main scroll view, the June 30th 2026 daily note renders block IDs rather than block contents. The note displays correctly once you click into it, so the underlying data is fine — likely a rendering/resolution issue in the scroll view for that note.


## Summary of Changes

Root cause: the June 30th 2026 daily page consists almost entirely of ((block-ref)) blocks, and the journal path never resolved them — /api/journal returned block trees without the block_ref_texts map (unlike /api/page), and Journal.tsx never provided BlockRefContext, so BlockRef rendered the raw ((uid)) fallback. Clicking into the page used PageView + /api/page, which does both — hence "right once we click in".

Fix (mirrors the /api/page → PageView pattern):
- server: get_journal now collects all returned block texts and includes block_ref_texts (routes_pages.py), test-first in test_journal_assets.py
- web: Journal.tsx accumulates block_ref_texts across batches (cleared on resync reset) and wraps the day list in BlockRefContext.Provider; JournalPayload type updated; test-first in Journal.test.tsx

Verified: 189 server tests + 158 web tests pass, tsc clean, and an end-to-end check against a read-only-sourced copy of the real database confirmed every June 30th block ref resolves in the journal payload.
