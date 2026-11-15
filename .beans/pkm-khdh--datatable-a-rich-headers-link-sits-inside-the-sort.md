---
# pkm-khdh
title: 'DataTable: a rich header''s link sits inside the sort button'
status: todo
type: bug
created_at: 2026-11-15T21:03:41Z
updated_at: 2026-11-15T21:03:41Z
parent: pkm-l79g
---

A plain table's header renders its cell's InlineSegments (Column.heading) inside DataTable's sort <button>. A [[ref]] in a header then puts an <a> inside a <button>. That is invalid HTML (interactive content inside a button), some engines do not deliver clicks to a button's descendants, and the button's accessible name reads oddly. DataTable's sort onClick currently ignores clicks whose target is inside an <a>.

Fix: render a heading that holds a link beside the sort button rather than inside it, or give the button a plain-text label and show the rich heading outside it.
Found in the Task 13 review (pkm-s8yh), Minor 4.
