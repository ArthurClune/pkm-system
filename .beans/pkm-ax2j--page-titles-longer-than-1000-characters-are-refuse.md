---
# pkm-ax2j
title: Page titles longer than 1,000 characters are refused
status: in-progress
type: feature
priority: normal
created_at: 2026-10-25T12:48:18Z
updated_at: 2026-10-25T17:51:47Z
parent: pkm-mfd0
---

Arthur, 2026-10-25 (decisions spec row 'Page title length'): page titles are limited to 1,000 characters, refused on create, rename and import like the other title rules. The server accepted a 2,000,000-character title, and a rename to a long title inflates every linking block. Check prod's longest title first.

- [ ] Prod survey: longest title
- [ ] Server: refuse on every title entry point (ops create_page, rename/merge, importer refuses naming the page, MCP/CLI via ops); web mirror for the editor/replica; parity fixture
- [ ] troubleshooting.md row; backend.md title rules

Arthur, 2026-10-25: a line whose text before `::` is over 1,000 characters stays refused (the attribute name is a page title); no grammar change.
