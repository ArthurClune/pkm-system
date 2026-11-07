---
# pkm-7knn
title: 'Outline: a block drag whose source row is removed mid-drag never ends; a later file drop moves the stale block'
status: todo
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding outline F6. Verdict: HOLDS-NARROWER.

A remote structural change that removes or reparents the dragged row during
the drag leaves the drag state set (dragend fires at a detached node). Any
later external drag over an outline is treated as that block drag: a Finder
file drop moves the old block (undoable) and the files are not uploaded. A
window-level `dragend` listener would not fix it.

- [ ] Red test
- [ ] Tag block drags with a custom MIME type and treat only drags carrying it as block drags
