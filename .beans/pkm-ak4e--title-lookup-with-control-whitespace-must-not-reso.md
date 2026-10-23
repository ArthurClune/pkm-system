---
# pkm-ak4e
title: Title lookup with control whitespace must not resolve to a different page
status: todo
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (Low): normalize_title collapses every whitespace run once a control character is present, so /api/page/A%20%20B%0A acts on page 'A B' while 'A  B' exists. GET, DELETE, rename (and MCP rename_page with allow_merge) all reach the folded page while the approval card shows the raw title.

- [ ] Decide the rule: fold only the control characters, or refuse a lookup key that folds onto a different existing title
- [ ] Regression test with both pages present for get, delete, rename and the MCP client path
