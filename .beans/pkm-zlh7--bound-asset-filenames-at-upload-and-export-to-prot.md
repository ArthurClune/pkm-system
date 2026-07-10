---
# pkm-zlh7
title: Bound asset filenames at upload and export to protect nightly backups
status: in-progress
type: bug
priority: high
created_at: 2026-07-10T10:57:05Z
updated_at: 2026-07-10T11:14:24Z
parent: pkm-m309
---

Review finding 4 (Important). The upload route (server/src/pkm/server/routes_assets.py:79-88) strips directories via Path(...).name but never bounds encoded byte length; safe_filename() in the exporter (server/src/pkm/export/markdown.py:37-38, server/src/pkm/export/writer.py:60-70) replaces unsafe chars but also doesn't truncate. Reproduced: an asset row with a 300-char .png filename makes export_graph() fail with OSError [Errno 63] File name too long. Direct tailnet API clients are a supported use case, so the HTTP API can create such rows. Impact: every later nightly export fails until the row is hand-fixed; the affected asset is never mirrored into the backup export dir; launchd failures may go unnoticed.

## Checklist
- [x] Normalize and byte-truncate filenames to a safe component limit at upload/import, preserving a usable extension
- [x] Apply the same defensive truncation in the exporter (existing rows may already be unsafe)
- [x] Handle '.'/'..' and empty-after-sanitization names explicitly
- [x] Regression: overlong ASCII filename upload → export succeeds
- [x] Regression: multibyte Unicode where char count is under the limit but UTF-8 byte count is over
- [x] Regression: dot names, collisions after truncation, extension preservation
