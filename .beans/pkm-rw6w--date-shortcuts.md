---
# pkm-rw6w
title: date shortcuts
status: completed
type: feature
priority: normal
created_at: 2026-07-29T08:47:02Z
updated_at: 2026-07-29T09:42:47Z
---

We need three new shortcuts that insert links to daily notes pages

1) '/today' -> [[July 29th, 2026]] (today's date)
2) '/tomorrow' -> [[July 30th, 2026]] (tomorrow's date)
3) '/date' -> launches date picker, clicking on date inserts a link to that date

## Summary of Changes

Implemented on branch worktree-pkm-rw6w-date-shortcuts (plan: docs/superpowers/plans/2026-07-29-date-shortcuts.md, subagent-driven, 4 tasks + final fable review, all clean):

- /today and /tomorrow: pure transforms in web/src/outline/slashCommands.ts; applySlashCommand now takes a required `now: Date` (clock read stays in the shell, FCIS). Titles via titleForDate only.
- /date: inline focus-preserving month-grid picker (new web/src/outline/calendar.ts core + web/src/components/DatePickerPopup.tsx, mouse-down-only so the textarea never blurs; insertion rides the setText draft path). Escape/typing closes; offset clamped.
- docs/keyboard.md rows (drift-guard green); unit+component tests; e2e web/e2e/slash-dates.spec.ts (2 tests, replica-sync waits per pkm-c9hp precedent).
- Full gate green: pnpm verify (unit 1608, e2e 44/44), server pytest 829 untouched.

Deferred one-liner follow-ups (final review: fine to defer): clear datePickerAt in tryAdopt on remote adoption; assert .today class in DatePickerPopup.test.tsx.
