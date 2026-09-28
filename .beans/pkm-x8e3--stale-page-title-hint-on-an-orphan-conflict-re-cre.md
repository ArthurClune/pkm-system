---
# pkm-x8e3
title: Stale page_title hint on an orphan conflict re-creates a renamed-away page
status: todo
type: bug
created_at: 2026-09-28T21:01:06Z
updated_at: 2026-09-28T21:01:06Z
---

Found in the pkm-3g4n final review. When an update_text targets a block the server no longer has, the daily-note conflict header links [[<page_title hint>]]. If that page was renamed after the client last saw it, the hint is the old title, so the header's ref re-creates an empty page under the old name. That is the effect replay_title_rewrites exists to prevent for live blocks. Options: resolve the hint through page-rename history before labelling; label an unknown title as plain text instead of a link; or fall back to (page unknown) when no page with that title exists. No data loss, only a stray empty page.
