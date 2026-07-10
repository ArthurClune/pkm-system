---
# pkm-x3so
title: 'Slash-command block handling: /Text broken, tab-complete missing, code blocks should wrap'
status: todo
type: bug
created_at: 2026-07-10T16:43:18Z
updated_at: 2026-07-10T16:43:18Z
---

A set of bugs and improvements around inserting and displaying text/code blocks via the slash menu.

- [ ] '/Text' doesn't work at all: start typing it, click on it — no response. Should insert a text block.
- [ ] '/Python code block' works when clicked, but tab-completion of the slash menu doesn't work and should (Tab accepts the highlighted entry).
- [ ] Code blocks (e.g. Python) should wrap long lines rather than showing horizontal scroll bars.
- [ ] Tests for slash-menu selection (click and Tab) and block insertion
