---
# pkm-jbjk
title: Ctrl-K wraps selection in [[]] link and positions cursor for alias
status: completed
type: feature
priority: normal
created_at: 2026-07-11T20:36:57Z
updated_at: 2026-07-12T07:43:33Z
---

When text is highlighted in the editor, pressing Ctrl-K should wrap the selection in square brackets and then place the cursor inside a () pair, i.e. selecting 'foo' and pressing Ctrl-K produces '[foo]()' with the cursor between the parentheses, ready to type the link target (markdown-style link creation shortcut).

## Summary of Changes

Cmd-K (mac) now wraps the selection as a markdown link `[sel]()` with the caret between the parens; with no selection it inserts an empty `[]()` with the caret between the brackets. Ctrl-K is deliberately left alone (emacs kill-line). Pure transform `wrapLink` in web/src/outline/keyEdits.ts (unit-tested); wired into BlockInput.onKeyDown in EditableBlockTree.tsx.
