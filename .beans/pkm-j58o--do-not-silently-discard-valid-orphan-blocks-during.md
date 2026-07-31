---
# pkm-j58o
title: Do not silently discard valid orphan blocks during import
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:58Z
updated_at: 2026-07-31T15:54:58Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 8.

**References:** server/src/pkm/importer/parse_export.py:116-135; server/src/pkm/importer/run.py:78-126

The importer records only the count of valid UID/string blocks unreachable from pages; it does not retain them. The replacement database is published before the warning report is written, so user content can be omitted and report failure can hide the warning.

**Direction:** Preserve orphan subtrees on a deterministic recovery page, or refuse publication unless an explicit lossy-import option is supplied. Complete preflight/reporting before swapping databases.

- [ ] Assert every orphan UID/text remains recoverable or import is refused
- [ ] Verify the existing database remains untouched on refusal/report failure
- [ ] Make lossy behavior explicit rather than warning after publication
