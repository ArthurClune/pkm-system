---
# pkm-khdh
title: 'DataTable: render header links as plain text'
status: todo
type: bug
priority: normal
created_at: 2026-11-15T21:03:41Z
updated_at: 2026-11-16T10:10:37Z
parent: pkm-l79g
---

A plain table's header renders its cell's InlineSegments (Column.heading) inside DataTable's sort <button>. A [[ref]] in a header then puts an <a> inside a <button>. That is invalid HTML (interactive content inside a button), some engines do not deliver clicks to a button's descendants, and the button's accessible name reads oddly. DataTable's sort onClick currently ignores clicks whose target is inside an <a>.

Fix: see the decision below; links in headers are not supported, so neither moving the link beside the button nor a second rich heading is wanted.
Found in the Task 13 review (pkm-s8yh), Minor 4.



Decision (Arthur, 2026-11-16): headers do not carry links. A header cell's [[ref]], #tag, ((ref)) or URL renders as its plain text inside the sort button; other inline formatting (bold, code) may stay. The header block itself is still ordinary outline text, so nothing stops someone typing a link there; the table just doesn't render it as one. Drop the closest("a") guard in the sort onClick once no header can hold an <a>.

Prod check (2026-11-16, copy of pkm.sqlite3): 41 table blocks, 160 header cells, none holding [[, #, ((, a markdown link or a URL. Headers do use **bold** and `code`, so a plain-text-only header would lose formatting real tables use.
