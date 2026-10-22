---
# pkm-lvyl
title: Importer skips a page with a refused title and carries on
status: completed
type: bug
priority: low
created_at: 2026-10-21T21:28:38Z
updated_at: 2026-10-22T09:21:05Z
parent: pkm-a1xk
---

Since pkm-0nzy and pkm-6mxb, importer/titles.sanitize_import_title raises ImportTitleError (malformed_syntax) for a title ending in ], holding a backtick, or with a . / .. / empty / segment, and importer/run.py then refuses the whole import (exit 2). The original Roam export holds such a page (`.`, from 2021-04-30), so a re-import would now be refused whole.

Arthur (2026-10-21): low priority for now; the importer should probably skip that page (and refs to it) and carry on, reporting what it skipped in the ImportReport, rather than stopping the whole import.

## Checklist
- [x] Decide what happens to blocks on a skipped page (drop with the page, or file elsewhere) and to refs pointing at it (plain text, as option B treats unreachable refs)
- [x] Skip and report instead of refusing; test with a fixture export holding `.`, `a]` and a backtick title


Ruling (Arthur, 2026-10-22): blocks go to the recovery page, refs become plain text via unlink_stale_refs.

## Summary of Changes

- titles.sanitize_export_titles skips a page whose title is refused (malformed or blank), reports it (SkippedPage: title, reason, location, block count) and appends its blocks after the orphan subtrees on the recovery page.
- A ref extract() reports with a refused title becomes plain text through unlink.unlink_stale_refs; text extract() reads as no ref ([[]], [[.]]) stays byte-identical. run.py no longer exits 2 on a title.
- The no-500 stored property now draws refused titles through import and serving.
- Real export: '' and '.' skipped (both empty), no text unlinked.
- Found pkm-zutb (rename loses the text of a code span between a link's brackets); filed separately.
- Docs: import-export-and-backup.md § Title sanitization table; a troubleshooting row.
