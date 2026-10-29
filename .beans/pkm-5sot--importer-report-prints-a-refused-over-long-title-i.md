---
# pkm-5sot
title: Importer report prints a refused over-long title in full
status: in-progress
type: bug
priority: low
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-10-29T16:06:50Z
parent: pkm-mfd0
---

From the security/batch-server final review (M4, T12 Minor 5). importer/report.py lists a page skipped for a title past MAX_PAGE_TITLE_CHARS with the whole title; local CLI output only. Clip it as the server's LONG_TITLE_LABEL rule does.

- [ ] Test with a 2M-char title
- [ ] Clip in the report
