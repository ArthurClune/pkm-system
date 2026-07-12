---
# pkm-3sxw
title: 'Auto-close bracket pairs: typing [ or ( inserts pair with cursor inside'
status: completed
type: feature
priority: normal
created_at: 2026-07-11T20:36:58Z
updated_at: 2026-07-12T07:43:33Z
---

In the editor, typing a single '[' should produce '[]' with the cursor between the brackets, and typing '(' should produce '()' with the cursor inside. Standard bracket auto-pairing behaviour.

Considerations:
- Should compose with the existing [[ page-link trigger (typing [ twice)
- Decide behaviour when text is selected (wrap selection vs replace)
- Decide whether typing the closing bracket over an auto-inserted one skips past it rather than inserting a duplicate

## Summary of Changes

Typing `[ ( { ` " '` auto-closes the pair with the caret inside; a selection is wrapped (inner text kept selected); typing a closing/symmetric char over its match skips past it. Quotes that abut a word char are left as apostrophes. Auto-pairing composes with the `[[` page-link trigger (typing `[` twice opens the ref popup) because the wiring re-runs detectAutocomplete. Pure logic `autoPairBracket` in web/src/outline/keyEdits.ts (unit-tested); wired into BlockInput.onKeyDown.
