---
# pkm-zc0c
title: image descriptions for uploaded assets
status: todo
type: feature
created_at: 2026-07-27T20:29:20Z
updated_at: 2026-07-27T20:29:20Z
parent: pkm-zx19
---

LLM-generated searchable descriptions for uploaded images. Design spec: docs/superpowers/specs/2026-07-27-pkm-zx19-image-descriptions-design.md

- assets gains description/described_at/describe_error columns (BASE_DDL + guarded migration; replica rebootstrap expected)
- describe/ package: Functional Core eligibility/prompt/parse, OpenAI vision via httpx (OPENAI_API_KEY, default gpt-4o-mini, config override), ImageDescriber protocol seam + sequential asyncio queue
- async enqueue on upload; POST /api/assets/scan (force retries failures); GET /api/assets/search (LIKE over description+filename); GET /api/assets/describe-status
- CLI: pkm assets search / pkm assets scan; MCP: search_assets (READ_TOOLS)
- enabled iff OPENAI_API_KEY set and config image_descriptions != false; /settings read-only status section
- openapi.json + web types regen; manual live smoke before deploy
- out of scope: PDFs, main search bar/FTS/offline parity, ollama, downscaling, file browser UI
