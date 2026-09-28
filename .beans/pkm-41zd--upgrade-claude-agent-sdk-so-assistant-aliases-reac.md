---
# pkm-41zd
title: Upgrade claude-agent-sdk so assistant aliases reach Opus/Sonnet 5.5
status: completed
type: task
priority: normal
created_at: 2026-09-28T20:18:15Z
updated_at: 2026-09-28T20:27:24Z
---

The assistant passes aliases (sonnet/opus/haiku) to claude-agent-sdk, which resolves them in its bundled Claude Code CLI. SDK 0.2.125 bundles CLI 2.1.217, where opus -> claude-opus-4-8 and sonnet -> claude-sonnet-5. Upgrade the SDK so the bundled CLI maps them to the 5.5 models.

- [x] Bump claude-agent-sdk in server/pyproject.toml and uv.lock
- [x] Verify bundled CLI alias mapping (opus -> claude-opus-5-5, sonnet -> claude-sonnet-5-5)
- [x] Server tests, pyrefly, ruff pass
- [x] Smoke-test a real assistant turn against the new CLI
- [x] Check docs/architecture/assistant.md for stale version/model claims

## Summary of Changes

- claude-agent-sdk 0.2.125 -> 0.2.161 (bundled CLI 2.1.217 -> 2.1.284). opus now resolves to claude-opus-5-5 and sonnet to claude-sonnet-5-5; haiku is unchanged at claude-haiku-4-5.
- 0.2.161 was published on 2026-09-28, which is inside the global uv cooldown (exclude-newer = 5 days). At Arthur's request, server/pyproject.toml exempts the SDK from the cooldown entirely ([tool.uv] exclude-newer-package = { claude-agent-sdk = false }), so re-locking always takes the newest release. Deploys still install whatever uv.lock pins.
- Smoke test through the SDK: opus -> claude-opus-5-5, haiku -> claude-haiku-4-5-20251001. The first cold run of sonnet served claude-sonnet-5; later runs served claude-sonnet-5-5. The CLI seems to gate the alias on a cached remote availability check (requiresModel in ~/.claude.json).
- docs/architecture/assistant.md: new Harness confinement row explaining that aliases are resolved by the bundled CLI, so new models arrive only through an SDK upgrade.
