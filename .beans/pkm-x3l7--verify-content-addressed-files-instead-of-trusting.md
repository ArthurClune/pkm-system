---
# pkm-x3l7
title: Verify content-addressed files instead of trusting existence
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 17).

## Context

**References:** `server/src/pkm/importer/run.py:101-107`; `server/src/pkm/export/writer.py:64-72`

Importer and backup export skip copying whenever the destination exists; they do not verify that bytes match the SHA in the path. Truncated or corrupted files can survive every later import/export.

**Direction:** Verify size and SHA-256 and atomically repair mismatches from the known source.

## Tasks

- [ ] Add same-size and truncated corruption repair tests
- [ ] Validate and repair existing content-addressed files
