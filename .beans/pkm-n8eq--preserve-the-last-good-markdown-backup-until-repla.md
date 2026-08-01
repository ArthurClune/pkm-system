---
# pkm-n8eq
title: Preserve the last good Markdown backup until replacement succeeds
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 16).

## Context

**References:** `server/src/pkm/export/writer.py:39-59`; `server/src/pkm/backup/__main__.py:79-84`

export_graph() deletes all current page/journal Markdown files before rendering replacements. Rendering, disk, permission, or asset-copy failure leaves a partial export and destroys the last known-good working tree.

**Direction:** Render and validate in staging, then atomically publish while preserving the export repository, or implement rollback-safe replacement.

## Tasks

- [ ] Inject rendering and copy failures and assert the previous export is byte-identical
- [ ] Publish exports atomically
