---
# pkm-452i
title: 'Assistant default model: glm when z.ai configured, sonnet otherwise'
status: completed
type: feature
priority: normal
created_at: 2026-08-19T16:16:02Z
updated_at: 2026-08-19T16:23:32Z
---

Arthur wants the harness default model changed from sonnet to glm. glm is only offered when a z.ai key is configured (available_models gates it), so the default must be availability-aware: glm when configured, sonnet fallback for keyless deployments and test doubles. Web picker needs no change — it adopts the server's fetched default from GET /api/assistant/models.

- [x] policy.py: replace DEFAULT_MODEL constant with availability-aware default_model()
- [x] service.py: resolve None model against the service's own available_models
- [x] routes.py: /api/assistant/models returns the service default
- [x] tests updated/added (keyless stays sonnet; zai-configured defaults glm)
- [x] pytest + pyrefly + ruff pass
- [x] docs/architecture backend.md + assistant-and-files.md default wording
- [x] openapi.json + gen-types regenerated (list_models docstring changed)

## Summary of Changes

`policy.DEFAULT_MODEL` ("sonnet") is replaced by `policy.default_model(available)`: glm when servable, sonnet otherwise. `AssistantService` computes `self.default_model` from its `available_models` and resolves a `None` create against it; `resolve_model` now only validates explicit names. `GET /api/assistant/models` returns the service default, so a z.ai-configured deployment (prod) advertises and creates glm by default while a keyless one stays on sonnet instead of 400ing every default create. Web needed no change: the picker adopts the fetched server default, and its "sonnet" initial state remains the fetch-failure fallback. Verified: server pytest (1604), pyrefly, ruff; web typecheck + unit (2298). E2E not run — no web source changed, only regenerated openapi.json/types.d.ts (docstring text), and the keyless e2e server's behavior is unchanged.
