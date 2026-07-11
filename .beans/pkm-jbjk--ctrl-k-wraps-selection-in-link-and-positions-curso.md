---
# pkm-jbjk
title: Ctrl-K wraps selection in [[]] link and positions cursor for alias
status: todo
type: feature
created_at: 2026-07-11T20:36:57Z
updated_at: 2026-07-11T20:36:57Z
---

When text is highlighted in the editor, pressing Ctrl-K should wrap the selection in square brackets and then place the cursor inside a () pair, i.e. selecting 'foo' and pressing Ctrl-K produces '[foo]()' with the cursor between the parentheses, ready to type the link target (markdown-style link creation shortcut).
