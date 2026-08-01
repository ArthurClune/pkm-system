---
# pkm-l457
title: Release outline test session handles when lease claims fail
status: todo
type: task
priority: low
created_at: 2026-08-01T20:00:12Z
updated_at: 2026-08-01T20:00:12Z
---

## Context

Follow-up from the final review of pkm-6phf. The local `reserveOutlineEditor()` helpers acquire an outline session and then throw if `claimEditor()` unexpectedly returns an ungranted lease, without first releasing the acquired handle. This affects only an already-failing test process, but can leak global outline-session state and cause cascading failures.

**References:** `web/src/views/EditablePage.test.tsx:34`; `web/src/components/EditableSidebarPanel.test.tsx:27`; `web/src/components/EditableBlockTree.dnd.test.tsx:24`

## Acceptance criteria

- [ ] Every `reserveOutlineEditor()` helper releases its acquired session handle before throwing on an ungranted lease
- [ ] Existing successful reservation and `finally` cleanup behavior remains unchanged
- [ ] Focused EditablePage, EditableSidebarPanel, and EditableBlockTree DnD suites pass
- [ ] Web typecheck and lint pass
