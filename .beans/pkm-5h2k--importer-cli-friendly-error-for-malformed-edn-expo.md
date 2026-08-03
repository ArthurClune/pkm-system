---
# pkm-5h2k
title: 'Importer CLI: friendly error for malformed EDN exports'
status: completed
type: task
priority: low
created_at: 2026-08-01T08:28:01Z
updated_at: 2026-08-03T13:44:53Z
parent: pkm-ulae
---

Follow-up from the pkm-ulae medium sweep (pkm-r72f final review).

## Context

`server/src/pkm/importer/run.py:58` calls `parse_edn` with no try/except, so a malformed Logseq export now surfaces as a raw Python traceback in the importer CLI instead of the friendly `error: ...` pattern the file already uses for the missing-file case (lines 51-53).

This matters more than before: pkm-r72f made the parser strict, so previously silently-corrupted inputs now raise `EdnError` — including `\/`, an escape JSON-influenced exporters sometimes emit that EDN doesn't define. The new `EdnError` messages carry zero-based Python character offsets, so the traceback is diagnostic, just unfriendly.

## Tasks

- [x] Wrap the importer CLI's parse call: `error: malformed export at offset N` + exit 2
- [x] Keep `\/` strict per importer requirements; regression coverage confirms refusal

## Summary of Changes

Structured every EDN parser failure with a zero-based character offset and stable detail, retained strict rejection of `\/`, and converted malformed importer input into an exact friendly exit-2 diagnostic before output creation.
