---
# pkm-au5m
title: Split docs/architecture/backend.md into focused docs
status: completed
type: task
priority: normal
created_at: 2026-08-04T21:28:29Z
updated_at: 2026-08-04T21:38:36Z
---

backend.md is too long and duplicates overview.md's tech stack. Split CLI/MCP to cli-and-mcp.md; embedded assistant + /files browser + image descriptions to assistant-and-files.md. Dedupe the tech stack toward overview.md. Update inbound anchors, overview's doc table, CLAUDE.md's enumeration, and the architecture-docs skill's symptom-table doc list.

## Summary of Changes

- backend.md: 1341 → 870 lines. CLI/MCP section moved to `docs/architecture/cli-and-mcp.md`; embedded assistant, assets//files browser and image descriptions moved to `docs/architecture/assistant-and-files.md`. Tech-stack table deleted; its extra bits (websockets, hatchling, httpx2, FastMCP) folded into overview.md's stack table.
- Corrections found while splitting: module map now lists `pkm/describe/` (was missing); 'the embedded assistant is the one HTTP surface not in this package' was wrong — `pkm/describe/routes.py` is also mounted from outside `pkm/server/`.
- The pkm-wn2s symptom row moved to assistant-and-files.md's own 'When something looks wrong' table; the upload-compensation paragraph moved to cli-and-mcp.md (client/workflows.py owns it).
- Inbound anchors updated (overview.md, frontend.md); CLAUDE.md's doc enumeration extended; architecture-docs SKILL.md's symptom-table doc list generalized to 'every mechanism-owning doc' (baseline subagent test showed the ownership rule already produced correct placement; wording change verified not to regress).
- check-docs.mjs passes on all six docs: links, anchors, mermaid ok; all 232 identifiers dropped from backend.md verified present in the new docs.
