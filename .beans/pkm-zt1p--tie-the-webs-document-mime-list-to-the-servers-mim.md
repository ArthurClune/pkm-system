---
# pkm-zt1p
title: Tie the web's document MIME list to the server's MIME policy table
status: completed
type: task
priority: normal
created_at: 2026-11-11T04:05:06Z
updated_at: 2026-11-11T14:14:04Z
parent: pkm-4gda
---

assets_core.MIME_POLICY now derives the server's upload, inline, document and describable sets. web/src/views/filesCore.ts keeps its own copy of the document MIME list. Generate it from the table or pin the two with a parity fixture.

## Summary of Changes

Pinned the web's Files-view MIME buckets to the server table with `shared/fixtures/mime_parity.json`: rows of {mime, category} for every `MIME_POLICY` type plus types outside it, written by `pkm.mime_parity_dump` (a `pkm.regen` step), checked for staleness by `test_mime_parity_fixture.py`, and replayed against `mimeCategory` in `filesCore.test.ts`. A type added to the server table now fails the server test until regenerated, and then fails the web test until `DOCUMENT_MIME` follows. Row added to backend.md's parity fixtures table.
