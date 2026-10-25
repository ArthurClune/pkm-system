---
# pkm-vcdi
title: 'Importer: backtick inserted beside an empty code span can swallow a later link'
status: todo
type: bug
priority: low
created_at: 2026-10-25T09:31:02Z
updated_at: 2026-10-25T09:31:02Z
parent: pkm-mfd0
---

From the pkm-dhsp re-review (2026-10-25). When a block's leading empty code span touches an attribute the export sanitiser backticks, the inserted backtick joins the empty span and turns a later [[Fine]] link into code, so that link is lost on import. Contrived input; no import is refused. Pre-existing shape that the new final pass now also reaches.

- [ ] Red test from the shape
- [ ] Insert the defusing backticks so they can't pair with neighbouring ones (or use a different defuse)
