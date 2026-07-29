---
# pkm-lehf
title: PDF descriptions for uploaded assets
status: todo
type: feature
created_at: 2026-07-29T16:03:26Z
updated_at: 2026-07-29T16:03:26Z
---

Extend the asset describe pipeline (server/src/pkm/describe/) to PDFs: generate a short searchable summary from the first page/first few pages, stored alongside image descriptions and surfaced via search_assets (CLI/MCP) and the /files browser.

Carried over from epic pkm-zx19 (closed with everything else shipped). Notes from the epic body:
- Reuse the existing describe service: same enable/disable config (image_descriptions in config.json), same graceful degradation when no API key or API errors (flag to user, ingest proceeds without summary)
- Should be picked up by the retrospective 'Scan for undescribed files' button in /files
- Open question: render first page to an image for the vision model, or extract text and summarise?
