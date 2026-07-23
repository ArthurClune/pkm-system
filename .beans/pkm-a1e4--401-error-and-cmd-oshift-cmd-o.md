---
# pkm-a1e4
title: 401 error and cmd-o/shift-cmd-o
status: todo
type: bug
priority: normal
created_at: 2026-07-23T15:32:49Z
updated_at: 2026-07-23T15:35:00Z
---

Within a block cmd-o opens a page reference and cmd-shift-o open it in the sidebar. If however the page hasn't been created yet, then this gives a 401 error as the page is created when the cursor leaves the [[]] tags. cmd-o/cmd-shift-o should create the page if it doesn't exist before jumping to it
