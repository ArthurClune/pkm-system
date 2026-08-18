---
# pkm-2i6a
title: Build shared popover chrome and dismissal behavior
status: completed
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-18T18:22:38Z
parent: pkm-wvvu
---

## Review findings

Frontend A2. File-card and block-reference popovers duplicate measurement, clamping, dialog chrome, outside-click dismissal, and Escape handling; dismissal is repeated across five components.

## Acceptance criteria

- [x] Add a shared Popover shell beside `popoverPosition.ts` with explicit support for the required remeasurement difference
- [x] Add a reusable dismissal hook for outside pointer interaction and Escape
- [x] Migrate both popovers plus SearchBar, TopBar, and BlockMenu where semantics match
- [x] Keep BlockMenu roving-focus keyboard behavior separate and intact
- [x] Preserve viewport clamping, focus behavior, propagation, roles, and file-reference navigation with component and browser coverage
- [x] Update frontend architecture/component guidance if the shared boundary becomes canonical

## Summary of Changes

Two new shared modules beside `popoverPosition.ts`:

- `web/src/Popover.tsx` — the anchored-popover chrome: `role="dialog"` on
  `.block-ref-popover`, post-layout measure, `clampPopoverPosition` into the
  viewport, and dismissal. The one caller-specific difference is an explicit
  required `remeasure` prop: the values whose change resizes the content and
  so invalidates the clamp. Undeclared re-renders are not re-measured.
- `web/src/useDismiss.ts` — `useDismiss(ref, onDismiss, { enabled,
  preventDefaultOnEscape })`: outside `mousedown` plus document-level Escape,
  both on `document`. `enabled` serves surfaces that stay mounted while
  closed; `preventDefaultOnEscape` preserves the per-callsite difference in
  whether the surface claims the keystroke.

Migrated: `BlockRefBacklinksPopover` and `FileCardPopovers` (its private
`CardPopover` deleted) onto the shell; `BlockMenu`, `TopBar`'s page menu and
`SearchBar` onto the hook. BlockMenu's roving focus, Tab-to-close and
initial-focus effect stay in the component, untouched.

Deliberately not migrated: `ConfirmDialog` and `ImageOverlay` (modal — `window`
listeners, Enter/Tab, scroll lock, focus restore), `AutocompletePopup` and
`DatePickerPopup` (no dismissal of their own; `BlockInput` owns their keys).

Coverage: 15 new unit tests for the two modules (written first, RED captured),
one new test pinning BlockMenu's roving focus and Tab-close, e2e outside-click
+ inside-click dismissal in `block-ref-indicator.spec.ts`, and a new page-menu
dismissal test in `delete-page.spec.ts`. `docs/architecture/frontend.md` gains
the modules in the map and a "Popovers and menus" section with the
shell-vs-hand-roll table.
