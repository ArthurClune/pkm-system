---
# pkm-pzdu
title: Click to navigate on resolved block refs
status: completed
type: feature
priority: normal
created_at: 2026-07-12T16:57:06Z
updated_at: 2026-07-12T17:02:19Z
---

Follow-up to pkm-y6af: clicking a resolved ((block ref)) should navigate to the page containing the target block (and ideally scroll to/highlight the block). Unresolved refs stay inert. Inner [[links]] inside the resolved text keep their own navigation.

Checklist:
- [x] BlockRef: resolved refs get role="link"; click/Enter navigates to
      pagePath(page_title)#uid; shift-click opens in sidebar (PageLink parity);
      clicks on nested anchors left to the anchor; unresolved refs stay inert
- [x] PageView: on load with a #uid hash, scroll the block into view and flash it
- [x] CSS: pointer/hover on resolved refs; flash-target animation
- [x] Web suite (417) + typecheck green
- [x] Verified e2e: ref on July 11th page → click → landed on July 12th page
      with #uid, target row flashed

## Summary of Changes

- `BlockRef.tsx`: resolved refs are now interactive (span with role="link",
  tabIndex): click or Enter navigates to the target's page with the block uid
  as the location hash; shift-click opens the page in the right sidebar, same
  as [[page links]]. Clicks on anchors nested in the resolved text (markdown
  links) are left to the anchor; propagation stops so the enclosing block
  never flips into edit mode. Unresolved ((uid)) spans stay non-interactive.
- `PageView.tsx`: a #uid hash scrolls to that block-row after the payload
  renders and applies a 1.6s `flash-target` highlight; unknown uids no-op.
- BlockRefProvider tests wrapped in MemoryRouter (BlockRef now uses
  useNavigate).
