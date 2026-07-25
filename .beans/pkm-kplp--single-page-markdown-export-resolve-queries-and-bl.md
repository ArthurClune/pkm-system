---
# pkm-kplp
title: 'Single-page markdown export: resolve queries and block refs to text'
status: todo
type: feature
created_at: 2026-07-25T12:02:10Z
updated_at: 2026-07-25T12:02:10Z
---

The end-user page export (GET /api/export/page/{title}) should resolve query blocks and ((block refs)) to their actual text, unlike the backup export (export_graph / nightly) which correctly keeps the raw query command and one-level refs. Split the rendering modes.
