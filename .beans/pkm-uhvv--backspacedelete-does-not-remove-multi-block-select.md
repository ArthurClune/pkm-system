---
# pkm-uhvv
title: Backspace/Delete does not remove multi-block selection
status: scrapped
type: bug
priority: high
created_at: 2026-07-23T14:29:35Z
updated_at: 2026-07-23T14:35:34Z
---

Regression of pkm-q89w: when multiple outline blocks are highlighted, pressing Backspace or Delete should delete the selected block roots.

## Acceptance Criteria

- [ ] Reproduce and identify the root cause of the regression.
- [ ] Add a failing automated test for Backspace and Delete on an active multi-block selection.
- [ ] Fix both keys so the selected blocks are deleted and selection state is cleared.
- [ ] Run focused tests and full web verification.

## Investigation Notes

Current main could not reproduce with keyboard-created block selections in scratch Chromium. Verified both Shift+Arrow selection + Backspace and Ctrl+Cmd+Arrow selection + Delete; in each case `.block-tree` became `document.activeElement`, both selected rows were removed, and selection cleared. Existing component and hook tests also pass. The missing scenario likely differs by selection method, browser/device, or focus state and needs that reproduction detail before changing behavior.

## Reasons for Scrapping

Neither the user nor the scratch Chromium verification can reproduce the issue on current main. Both supported keyboard selection paths delete correctly with Backspace and Delete. The original report occurred on an iPad and was likely running an older cached PWA/service-worker bundle. No code change is justified without a reproducible failing path.
