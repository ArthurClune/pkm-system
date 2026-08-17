---
# pkm-2i6a
title: Build shared popover chrome and dismissal behavior
status: todo
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-17T20:55:23Z
parent: pkm-wvvu
---

## Review findings

Frontend A2. File-card and block-reference popovers duplicate measurement, clamping, dialog chrome, outside-click dismissal, and Escape handling; dismissal is repeated across five components.

## Acceptance criteria

- [ ] Add a shared Popover shell beside `popoverPosition.ts` with explicit support for the required remeasurement difference
- [ ] Add a reusable dismissal hook for outside pointer interaction and Escape
- [ ] Migrate both popovers plus SearchBar, TopBar, and BlockMenu where semantics match
- [ ] Keep BlockMenu roving-focus keyboard behavior separate and intact
- [ ] Preserve viewport clamping, focus behavior, propagation, roles, and file-reference navigation with component and browser coverage
- [ ] Update frontend architecture/component guidance if the shared boundary becomes canonical
