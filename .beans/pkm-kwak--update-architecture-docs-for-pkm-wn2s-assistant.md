---
# pkm-kwak
title: Update architecture docs for pkm-wn2s assistant
status: completed
type: task
priority: normal
created_at: 2026-07-27T07:56:20Z
updated_at: 2026-07-27T08:02:19Z
---

docs/architecture/ (overview.md, backend.md, frontend.md) predate the pkm-wn2s merge and don't cover the embedded LLM assistant (server pkm.assistant package, SSE /api/assistant/* routes, Claude Agent SDK engine, web src/assistant/ panel). Update them to reflect the shipped functionality.

- [x] Update overview.md (diagram, capability table, subsystem pointers)
- [x] Update backend.md (pkm.assistant package, SSE routes, engine/service/policy)
- [x] Update frontend.md (src/assistant/, panel, SSE client)
- [x] Check sync-and-offline.md for needed mentions (none needed: assistant is online-only and orthogonal to sync; noted in frontend.md instead)

## Summary of Changes

- overview.md: assistant harness in the system-context diagram (spawned per conversation, loops back via pkm-mcp stdio to the same HTTP API), doc-index rows, repo-layout + tech-stack entries, new load-bearing decision (the assistant is a client, not a backdoor).
- backend.md: tech-stack row (claude-agent-sdk), module-map entry, /api/assistant/* rows in the HTTP API reference, and a new section 'Embedded assistant (pkm/assistant/)' covering the per-file table, confinement mechanics (ENABLE_TOOL_SEARCH=false, confirm gate via can_use_tool, minted 0600 PKM_CLI_CONFIG), FakeEngine testing, and the subscription-login deploy prerequisite.
- frontend.md: src/assistant/ module-map entry, Cmd/Ctrl+J + Assistant sidebar entry in Views, new section 'The assistant panel' (lazy conversation, model lock, SSE event folding, streamMessage 401 handling, online-only).
- design.md: 'Embedded assistant' row in The pieces, linking the pkm-wn2s spec + plan.

SECURITY.md, keyboard.md and deploy/README.md were already updated as part of pkm-wn2s itself.
