---
# pkm-fy52
title: GET /api/page auto-creates daily pages on read
status: todo
type: bug
priority: normal
created_at: 2026-07-22T09:51:38Z
updated_at: 2026-07-22T10:12:47Z
---

GET /api/page/<title> (and pkm get) auto-creates an empty page row when the title parses as a daily note. Reads should not write: during the pkm-8uld investigation, three empty daily pages (July 19-21) were created just by fetching them, and the wedged client's DELETE/GET churn kept resurrecting July 11th. Auto-create belongs to the journal mount (today only) and explicit save paths, not to arbitrary page GETs. Check server routes_pages fetch path and CLI.

Design refined in docs/superpowers/specs/2026-07-22-sync-hardening-design.md (Fix C, incident bean pkm-8uld): server auto-creates ONLY today's title; web PageView renders empty editable page for missing-daily 404 (lazy create on first edit); journal day loaders map 404 to empty; replica localApi mirrors.
