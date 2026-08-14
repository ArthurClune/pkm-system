---
# pkm-af7s
title: 'Assistant: z.ai GLM provider via coding plan (Anthropic-compatible endpoint)'
status: completed
type: feature
priority: normal
created_at: 2026-08-14T16:43:43Z
updated_at: 2026-08-14T17:41:20Z
---

Add z.ai GLM support to the assistant without a second engine: ClaudeEngine routes model=glm to the z.ai Anthropic-compatible endpoint (https://api.z.ai/api/anthropic) via ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in the SDK subprocess env, passing model=sonnet (z.ai maps aliases to its plan-default GLM). Key file PKM_HOME/zai_key (config: zai_api_key_file, env fallback ZAI_API_KEY, file wins). New GET /api/assistant/models exposes available models so the web picker hides glm when no key; create() still 400s on glm without a key.

## Todo

- [x] policy.py: add glm to MODELS + available_models(zai_configured)
- [x] config: zai_api_key_file resolution (file beats ZAI_API_KEY env)
- [x] claude_engine.py: zai_token param + per-conversation env/model routing
- [x] routes.py: GET /api/assistant/models
- [x] app.py wiring
- [x] web: fetch models list, render picker from it (fallback to claude trio)
- [x] openapi.json regen + gen-types
- [x] docs: assistant-and-files.md + backend.md API table + deploy note
- [x] tests green (server pytest, pyrefly, ruff, web verify)
- [x] live smoke with real z.ai key (glm hidden pre-key verified on prod endpoint + by Arthur in UI; key added, service restarted, glm offered; live glm turn on prod called the search tool and answered from the graph — harness subprocess env showed ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic and server.err.log shows "assistant harness started (model=glm)")

## Summary of Changes

Shipped in two commits on worktree-zai-glm-assistant (2cfc828 feature, 5f9ae4a review fixes):
- policy.py: glm in MODELS, ZAI_MODELS set, available_models(zai_configured)
- claude_engine.py: model in ZAI_MODELS routes to https://api.z.ai/api/anthropic via ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in the SDK subprocess env, SDK gets the sonnet alias (z.ai maps aliases to plan-default GLM); fail-closed without a token; startup log names the requested model
- config/app.py: zai_api_key_file (default PKM_HOME/zai_key), _resolve_key dedup, read once at startup
- routes.py: GET /api/assistant/models (models + default); service.create rejects unoffered models
- web: picker renders fetched list, lazy fetch on first panel open with retry-after-failure, adopts server default unless user picked
- docs: assistant-and-files.md provider-routing bullet (incl. accepted token-in-subprocess-env exposure), backend.md API table, frontend.md, deploy README (restart to rotate key)
- 9 review findings resolved (8th accepted with doc note)
