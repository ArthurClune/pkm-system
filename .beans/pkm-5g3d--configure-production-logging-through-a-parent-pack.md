---
# pkm-5g3d
title: Configure production logging through a parent package logger
status: todo
type: task
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 25).

## Context

**References:** logger declarations in `server/src/pkm/server/routes_assets.py:34`, `server/src/pkm/assistant/claude_engine.py:50`, and `server/src/pkm/assistant/service.py:16`; `server/src/pkm/server/logfmt.py:34-57`

Production logging explicitly configures only pkm.access and pkm.describe. New pkm.assets and pkm.assistant loggers can lose intended INFO lifecycle output and project formatting, repeating the logger-registration drift previously fixed for describe.

**Direction:** Configure a parent pkm logger once, with explicit stream/format overrides only where required.

## Tasks

- [ ] Add a test enumerating pkm.* loggers and asserting effective handlers/levels
- [ ] Replace the open-ended logger allowlist with a parent policy
