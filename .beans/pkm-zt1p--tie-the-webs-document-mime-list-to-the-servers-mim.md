---
# pkm-zt1p
title: Tie the web's document MIME list to the server's MIME policy table
status: todo
type: task
created_at: 2026-11-11T04:05:06Z
updated_at: 2026-11-11T04:05:06Z
parent: pkm-4gda
---

assets_core.MIME_POLICY now derives the server's upload, inline, document and describable sets. web/src/views/filesCore.ts keeps its own copy of the document MIME list. Generate it from the table or pin the two with a parity fixture.
