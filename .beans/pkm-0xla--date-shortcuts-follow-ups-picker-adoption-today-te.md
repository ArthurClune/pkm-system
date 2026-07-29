---
# pkm-0xla
title: 'date-shortcuts follow-ups: picker adoption + .today test'
status: completed
type: task
priority: normal
created_at: 2026-07-29T09:54:44Z
updated_at: 2026-07-29T09:58:14Z
---

Two deferred one-liners from the pkm-rw6w final review: (1) clear datePickerAt in tryAdopt's adoption branch so a remote edit landing while the /date picker is open closes it instead of leaving a shifted insert offset (clamp already prevents corruption); soften the 'can never go stale' comment. (2) assert the .today highlight class in DatePickerPopup.test.tsx.

## Summary of Changes

- tryAdopt (EditableBlockTree.tsx) now clears datePickerAt before adopting remote text, so a remote edit landing while the /date picker is open closes the picker instead of leaving a stale insert offset (clamp remains as backstop); state comment softened per final-review wording. New component test: 'a remote update adopted while the picker is open closes it' (RED confirmed pre-fix).
- DatePickerPopup.test.tsx now asserts exactly one .today cell, on the in-month day 29 (June 29 outside cell shares the number).

Verified: pnpm test:unit 1610/1610, typecheck, check:fcis clean; full pnpm verify before merge.
