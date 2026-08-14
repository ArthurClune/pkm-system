---
# pkm-af7s
title: 'Assistant: z.ai GLM provider via coding plan (Anthropic-compatible endpoint)'
status: in-progress
type: feature
priority: normal
created_at: 2026-08-14T16:43:43Z
updated_at: 2026-08-14T16:59:40Z
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
- [ ] live smoke with real z.ai key (needs Arthur)
