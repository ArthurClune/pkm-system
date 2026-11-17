---
# pkm-3rk8
title: Three e2e specs press Ctrl-J before the app's key listener is attached
status: completed
type: bug
priority: normal
created_at: 2026-11-17T21:23:01Z
updated_at: 2026-11-17T21:27:59Z
---

Symptom: on a loaded machine, assistant-asset-link.spec.ts and both assistant-reply specs in external-media.spec.ts fail with `expect(locator).toBeVisible() failed` / `Locator: getByRole('region', { name: 'Assistant' })` / `element(s) not found`. They passed in a quiet full run earlier the same evening, and failed at every commit tried later (2e9f0bb0, 6cdbf6c9, d5b5eb91) while a game was running.

Cause: each spec reloads `/` with page.goto and presses Control+j at once. App's Ctrl-J handler is a window keydown listener added in a useEffect, so a key pressed before that effect runs is lost. A 2 s wait before the press made the spec pass, and a capture-phase probe showed the key reaching BODY with nothing preventing it.

Fix: these specs are about asset links and external media, not the shortcut, so they open the panel with the nav's Assistant button, whose click React delegates from the first render and which only ever opens. assistant.spec.ts keeps testing Ctrl-J.

- [x] Open the panel by button in the three specs
- [x] The three specs pass; full Playwright suite passes

## Summary of Changes

assistant-asset-link.spec.ts and the two assistant-reply specs in external-media.spec.ts open the panel with the nav's Assistant button instead of Ctrl-J after a reload. Full Playwright suite: 130 passed on the same loaded machine where the three had failed at every commit tried.
