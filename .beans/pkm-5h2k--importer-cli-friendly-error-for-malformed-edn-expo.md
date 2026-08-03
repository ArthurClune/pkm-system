---
# pkm-5h2k
title: 'Importer CLI: friendly error for malformed EDN exports'
status: in-progress
type: task
priority: low
created_at: 2026-08-01T08:28:01Z
updated_at: 2026-08-03T13:01:44Z
parent: pkm-ulae
---

Follow-up from the pkm-ulae medium sweep (pkm-r72f final review).

## Context

`server/src/pkm/importer/run.py:58` calls `parse_edn` with no try/except, so a malformed Logseq export now surfaces as a raw Python traceback in the importer CLI instead of the friendly `error: ...` pattern the file already uses for the missing-file case (lines 51-53).

This matters more than before: pkm-r72f made the parser strict, so previously silently-corrupted inputs now raise `EdnError` — including `\/`, an escape JSON-influenced exporters sometimes emit that EDN doesn't define. The new `EdnError` messages carry byte offsets, so the traceback is diagnostic, just unfriendly.

## Tasks

- [ ] Wrap the importer CLI's parse call: `error: malformed export at offset N` + exit 2
- [ ] Consider whether `\/` should be tolerated (Logseq-compat) or stay strict; check a real export
