---
# pkm-c17m
title: Avoid orphan assets in upload-and-link workflows
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 24).

## Context

**References:** `server/src/pkm/cli/main.py:405-416`; `server/src/pkm/mcp/server.py:153-168`; `server/src/pkm/client/api.py:135-142`

The asset is uploaded before page/parent validation and before the block operation. Invalid parents or failed operations leave unlinked assets; CLI prints the URL before linking succeeds.

**Direction:** Resolve/validate destination before upload, delay success output, and add either a transactional endpoint or compensating deletion for post-upload write failure.

## Tasks

- [ ] Add invalid-parent and post-upload operation-failure tests
- [ ] Prevent or compensate orphaned uploads
