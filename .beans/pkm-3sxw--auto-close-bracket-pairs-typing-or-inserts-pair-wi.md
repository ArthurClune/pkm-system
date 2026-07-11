---
# pkm-3sxw
title: 'Auto-close bracket pairs: typing [ or ( inserts pair with cursor inside'
status: todo
type: feature
created_at: 2026-07-11T20:36:58Z
updated_at: 2026-07-11T20:36:58Z
---

In the editor, typing a single '[' should produce '[]' with the cursor between the brackets, and typing '(' should produce '()' with the cursor inside. Standard bracket auto-pairing behaviour.

Considerations:
- Should compose with the existing [[ page-link trigger (typing [ twice)
- Decide behaviour when text is selected (wrap selection vs replace)
- Decide whether typing the closing bracket over an auto-inserted one skips past it rather than inserting a duplicate
