---
# pkm-zc0c
title: image descriptions for uploaded assets
status: completed
type: feature
priority: normal
created_at: 2026-07-27T20:29:20Z
updated_at: 2026-07-28T06:25:51Z
parent: pkm-zx19
---

LLM-generated searchable descriptions for uploaded images. Design spec: docs/superpowers/specs/2026-07-27-pkm-zx19-image-descriptions-design.md
Implementation plan: docs/superpowers/plans/2026-07-27-pkm-zc0c-image-descriptions.md

## Tasks

- [x] Task 1: config keys (image_descriptions, image_description_model)
- [x] Task 2: assets description columns + guarded migration + fix positional INSERTs + regen baseSchema.gen.ts
- [x] Task 3: describe/core.py pure logic (eligibility, payload, parsing, status)
- [x] Task 4: describe/service.py queue worker + fake_describer.py
- [x] Task 5: describe/openai_client.py (httpx2, MockTransport tests)
- [x] Task 6: app wiring, upload hook, scan/status/search routes, openapi+types regen
- [x] Task 7: CLI pkm assets search/scan
- [x] Task 8: MCP search_assets tool + READ_TOOLS
- [x] Task 9: web /settings status section
- [x] Task 10: docs, full verification, bean completion
- [x] Manual live smoke with real OPENAI_API_KEY before/with deploy

## Notes

- Out of scope: PDFs, main search FTS/offline parity, ollama, downscaling, file browser UI (pkm-jdu3)
- Replica rebootstrap expected after deploy (BASE_DDL change)

## Live smoke outcome (2026-07-28)

Ran on the branch with a real key, local servers on ports 8998/8999:
- Fresh DB: upload of a real slide PNG → described by gpt-4o-mini in seconds; `/api/assets/describe-status` {enabled:true}; term search (API + `pkm assets search`) finds it by description text; truncation to 1000 chars observed working.
- Prod DB copy: guarded migration added the three columns in place; `POST /api/assets/scan` queued 1091 eligible images; sequential worker described 31 in ~4 min with 0 failures and no rate-limit errors before the test was stopped. Sample descriptions are high-quality OCR-style text.
- Prod deploy note: replica rebootstrap expected (BASE_DDL change); set OPENAI_API_KEY in the service environment and run `pkm assets scan` (or POST /api/assets/scan) once after deploy to describe the backlog (~1090 images, sequential).

## Summary of Changes

12 commits, base 4454762: config keys; assets description columns + guarded migration + positional-INSERT fixes + baseSchema regen; pkm.describe package (core/service/openai_client/routes, FCIS); upload enqueue hook; describe-status/scan/search routes + openapi/types regen; CLI `pkm assets search|scan`; MCP `search_assets` (READ_TOOLS); /settings status section; backend docs. Final review fixes: async scan route, gif wording, CLI help drift guard. Gates: 814 server tests (95.88% cov), pyrefly/ruff clean, pnpm verify green.
