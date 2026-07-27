---
# pkm-zc0c
title: image descriptions for uploaded assets
status: in-progress
type: feature
priority: normal
created_at: 2026-07-27T20:29:20Z
updated_at: 2026-07-27T21:33:20Z
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
- [ ] Manual live smoke with real OPENAI_API_KEY before/with deploy

## Notes

- Out of scope: PDFs, main search FTS/offline parity, ollama, downscaling, file browser UI (pkm-jdu3)
- Replica rebootstrap expected after deploy (BASE_DDL change)
