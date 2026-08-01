---
# pkm-getl
title: Nudge connected replicas after journal cleanup
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 10).

## Context

**References:** `server/src/pkm/server/routes_pages.py:423-448`; `server/src/pkm/server/notify.py:1-38`; change triggers in `server/src/pkm/schema.py:129-150`

Journal cleanup commits page/block deletions and advances changes.seq but sends no sequence nudge. Connected replicas can retain deleted pages until another mutation or reconnect. This overlaps the previously scrapped pkm-ie73, but the current invariant remains broken.

**Direction:** Send a post-commit nudge when cleanup deletes rows, and centralize the commit-then-nudge protocol to prevent route omissions.

## Tasks

- [ ] Add WebSocket coverage for journal cleanup
- [ ] Add a mutation-route contract test for every journal-advancing endpoint
- [ ] Centralize or enforce post-commit notification
