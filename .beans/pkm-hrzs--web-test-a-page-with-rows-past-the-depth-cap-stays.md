---
# pkm-hrzs
title: 'Web test: a page with rows past the depth cap stays editable elsewhere'
status: todo
type: task
priority: low
created_at: 2026-10-24T14:58:27Z
updated_at: 2026-10-24T14:58:27Z
parent: pkm-mfd0
---

The depth-cap spec promises legacy rows past level 100 stay readable and their text editable, and that only where an op places blocks is judged. Server tests cover it; no web test does (a mutant judging the whole page's deepest row was caught only by chance).

- [ ] useOutline test: a page holding a 120-level legacy chain; indent/move/paste elsewhere at shallow levels applies, and editing the deep rows' text applies
- [ ] Show it goes red against a mutant that judges the whole page's depth
