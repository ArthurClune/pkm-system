---
# pkm-79rz
title: 'Assistant: SDK bump, fable model, Local copy:: link format in prompt'
status: completed
type: feature
priority: normal
created_at: 2026-10-20T18:41:11Z
updated_at: 2026-10-20T18:49:53Z
---

The assistant's haiku alias resolves to claude-haiku-4-5 under claude-agent-sdk 0.2.161 (bundled CLI 2.1.284); 0.2.168 (CLI 2.1.301) maps it to claude-haiku-5-5 and adds the fable alias (claude-fable-5-1). Asking the assistant to fix a line like 'Local copy:: pkm/Papers/Machine Learning/complex paper.pdf' makes it hunt for an example link to copy, because the system prompt never states the format.

- [x] Bump claude-agent-sdk to 0.2.168 in server/uv.lock (and the pyproject floor)
- [x] Add fable to AssistantModel, MODELS, the web fallback list; default unchanged (glm when keyed, else sonnet)
- [x] Regenerate openapi.json / types.d.ts
- [x] System prompt section on Local copy:: links, with a test pinning its worked example to local_href()
- [x] Docs: assistant.md model list; grep for stale counts
- [x] Server tests, pyrefly, ruff, pnpm verify, proptest gate as applicable

## Summary of Changes

- claude-agent-sdk 0.2.161 -> 0.2.168 (bundled CLI 2.1.284 -> 2.1.301): haiku now resolves to claude-haiku-5-5 instead of claude-haiku-4-5; sonnet/opus unchanged (5.5).
- New assistant model `fable` (claude-fable-5-1 via the subscription, not z.ai) in AssistantModel, MODELS and the web fallback; OpenAPI contract regenerated. Default unchanged: glm when a z.ai key is configured, else sonnet.
- System prompt gains a Local copy:: section (target form, root-prefix stripping, quote(rel, safe='/') encoding, worked example); a test pins the example to local_href().
- assistant.md, backend.md, frontend.md model lists updated.
