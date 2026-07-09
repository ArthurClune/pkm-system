---
# pkm-kiip
title: Heading slash commands (/h1 /h2 /h3)
status: todo
type: feature
created_at: 2026-07-09T21:25:53Z
updated_at: 2026-07-09T21:25:53Z
---

Deferred from pkm-j5n6 (slash commands). /h1 /h2 /h3 would set a block's `heading` field, but there is currently no writable op path for heading on an existing block:

- Server: CreateOp (server/src/pkm/server/ops_core.py:23) carries `heading` and is only applied at insert time (ops_apply.py:78-81). UpdateTextOp (routes_ops.py / ops_core.py) has no heading field, and there is no SetHeadingOp.
- Client: web/src/api/types.d.ts's UpdateTextOp mirrors this — no heading field to send.

Per pkm-j5n6's scope, no new server op was added to keep that change out of this feature's blast radius. To implement /h1-/h3:
1. Add a server-side op (e.g. SetHeadingOp or extend UpdateTextOp) + handler in ops_apply.py/ops_core.py that can change heading on an existing block.
2. Regenerate the OpenAPI client types (web/src/api/types.d.ts).
3. Wire a client-side op-queue helper (mirroring how UpdateTextOp is sent) and extend web/src/outline/slashCommands.ts (see SLASH_COMMANDS in that file, already scaffolded with /text /todo /python /bash /javascript) with h1/h2/h3 entries that call the new op instead of a text transform.
4. detectAutocomplete's slash context (web/src/outline/autocomplete.ts) already fires for any /<letters> prefix, so /h1 etc. will show up once added to the command list — no detection changes needed.
