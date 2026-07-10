---
# pkm-tmtf
title: Focused block without a draft must adopt remote text updates
status: todo
type: bug
priority: high
created_at: 2026-07-10T10:56:40Z
updated_at: 2026-07-10T10:57:50Z
parent: pkm-m309
---

Review finding 2 (Important). useOutline (web/src/outline/useOutline.ts:119-136) filters remote update_text ops by focused-block UID alone, but focus does not imply a pending draft. Click into a block, type nothing, and a remote update from another client is committed server-side but never shown locally — the focused client keeps stale text until an unrelated refetch, and a later edit from it can overwrite the unseen remote change. Current behavior is codified by web/src/views/EditablePage.test.tsx:77-86, which will need updating.

Fix direction per review: base conflict behavior on an actual pending draft, not focus. E.g. apply remote text to the underlying block tree even while the textarea holds a local component draft; a real draft flush then becomes the next legitimate last-writer. The no-draft case must adopt the remote value.

## Checklist
- [ ] Apply remote update_text to block tree when focused block has no pending local draft
- [ ] Decide and implement LWW behavior when a real local draft exists
- [ ] Update EditablePage.test.tsx:77-86 to the new contract
- [ ] Regression: focused, no local change → remote update displayed/adopted
- [ ] Regression: focused with pending draft → chosen LWW behavior verified
- [ ] Regression: focus then blur without editing after remote update → client and server consistent
