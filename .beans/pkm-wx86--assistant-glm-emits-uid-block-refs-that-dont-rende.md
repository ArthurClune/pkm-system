---
# pkm-wx86
title: 'Assistant: GLM emits ((^uid)) block refs that don''t render'
status: completed
type: bug
priority: normal
created_at: 2026-08-14T17:56:02Z
updated_at: 2026-08-14T18:01:27Z
---

GLM copies the trailing ^uid marker from MCP tool output verbatim into block-ref citations, producing ((^dfflHRRvB)). scan.ts BLOCK_REF_RE has no ^ in its character class, so the citation stays plain text in the assistant panel.

Root cause chain:
- cli/render.py:56 renders blocks with trailing '  ^uid' markers (tool output the model sees)
- policy.py SYSTEM_PROMPT says cite as ((uid)); Claude strips the ^, GLM does not
- web/src/grammar/scan.ts:57 BLOCK_REF_RE rejects ^, so ((^uid)) falls through as plain text

Agreed fix (options 1+2 only; grammar widening explicitly rejected):
- [x] Prompt hardening in policy.py: uid is the part after the ^ marker, never include the caret
- [x] Assistant render-path normalization: strip ^ inside ((^uid)) in assistant message text before tokenizeBlock (contained to assistant; shared grammar untouched)

## Summary of Changes

- `server/src/pkm/assistant/policy.py`: SYSTEM_PROMPT now names the trailing ^uid marker convention and shows the wrong form explicitly (write ((abc123)), never ((^abc123))); pinned by test_system_prompt_warns_against_caret_in_block_ref_citations.
- `web/src/assistant/normalizeRefs.ts` (new, Functional Core): stripCaretBlockRefs rewrites ((^uid)) -> ((uid)) for uid matching [a-zA-Z0-9_-]{6,}; leaves bare ^uid markers, short bodies, and non-uid text alone. Applied in AssistantPanel before tokenizeBlock, so it is contained to assistant rendering; the shared ref grammar (refs.py / scan.ts / ref_grammar.json) is untouched by design.
- docs/architecture/frontend.md: render-path note in The assistant panel + symptom row.

Verified: server pytest 1461 passed (96.98% cov), ruff, pyrefly clean; web pnpm verify (typecheck, unit coverage, 53 e2e) green.
