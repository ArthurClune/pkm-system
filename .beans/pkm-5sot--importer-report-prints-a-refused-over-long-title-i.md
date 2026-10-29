---
# pkm-5sot
title: Importer report prints a refused over-long title in full
status: completed
type: bug
priority: low
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-10-29T17:00:21Z
parent: pkm-mfd0
---

From the security/batch-server final review (M4, T12 Minor 5). importer/report.py lists a page skipped for a title past MAX_PAGE_TITLE_CHARS with the whole title; local CLI output only. Clip it as the server's LONG_TITLE_LABEL rule does.

- [x] Test with a 2M-char title
- [x] Clip in the report



## Summary of Changes

`importer/report.py` clips any over-long title (past the page-title cap) to a short prefix plus the character count, for title changes, skipped pages and recovery titles, mirroring the server long-title label rule. Pinned by `test_report.py`: a 2M-char title stays bounded, a cap-boundary case, and the orphan line is covered. Docs: a troubleshooting row. The final fix wave added the orphan-line coverage; in-body test imports were left, matching the file's neighbours.
