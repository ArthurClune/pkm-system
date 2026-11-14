---
# pkm-tszg
title: Escape doesn't close the find bar when focus is on the page
status: completed
type: bug
priority: normal
created_at: 2026-11-14T17:30:51Z
updated_at: 2026-11-14T17:35:30Z
---

On the iPad home-screen app (Caps Lock mapped to Esc), Escape left the find bar open after clicking into the page: the bar only handled Escape on its own element, so with focus in a block or on the page the key never reached it. The PDF/reader viewers close from anywhere because their Escape listener is on window.

## Summary of Changes

Symptom: with the find bar open (installed app, observed on the iPad
home-screen app with Caps Lock mapped to Esc), clicking into the page and
pressing Escape left the bar open.

Cause: Escape was handled by a React `onKeyDown` on the `.find-bar` element,
so it fired only while focus was inside the bar.

Fix: `FindBar`'s window capture-phase keydown listener takes Escape while the
bar is open (not under a modal, not mid-IME-composition) and closes it, the
way `useModal` closes the viewers. A block being edited keeps its edit; the
next Escape leaves it. Rule stated in docs/architecture/frontend.md
§ Navigation (the global chords paragraph). Unit tests in
`FindBar.test.tsx` and an e2e step in `find-in-page.spec.ts` pin it; the
e2e failed against the old component.
