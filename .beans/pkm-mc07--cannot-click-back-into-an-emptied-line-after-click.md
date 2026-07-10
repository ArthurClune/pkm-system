---
# pkm-mc07
title: Cannot click back into an emptied line after clicking away
status: todo
type: bug
created_at: 2026-07-10T12:50:50Z
updated_at: 2026-07-10T12:50:50Z
---

A line that has never been written to behaves correctly (shows the 'click to start writing' placeholder and is clickable). But if a line has content that is then deleted, clicking off that now-empty line leaves it in a state where you can't click back into it. Suspected: the empty-but-previously-written line doesn't get restored to the same clickable/placeholder state as a never-written line. (Note: user's report said 'means you can click back in' — assumed typo for 'can't'; verify exact repro when picking this up.)
