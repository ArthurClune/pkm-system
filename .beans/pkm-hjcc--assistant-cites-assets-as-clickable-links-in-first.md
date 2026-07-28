---
# pkm-hjcc
title: Assistant cites assets as clickable links in first pass
status: completed
type: feature
priority: normal
created_at: 2026-07-28T11:02:16Z
updated_at: 2026-07-28T11:18:50Z
---

SYSTEM_PROMPT tweak so first-pass answers cite assets by full /assets/<sha>/<filename> URL (rendered clickable by pkm-gdi5) and blocks as ((uid)); also de-drift the 'ten PKM verbs' count. Spec: docs/superpowers/specs/2026-07-28-assistant-first-pass-asset-links-design.md

## Tasks

- [x] SYSTEM_PROMPT: asset-URL + ((uid)) citing rules; remove tool count
- [x] test_assistant_policy.py: assert citing guidance present
- [x] pytest + pyrefly + ruff green
- [x] Live smoke: first-pass answer carries clickable asset links

## Summary of Changes

SYSTEM_PROMPT (server/src/pkm/assistant/policy.py) gained a Citing stanza: mention assets by their full /assets/<sha256>/<filename> URL exactly as search_assets returned them (never filename alone), and cite specific blocks as ((uid)) — the panel renders both clickable (pkm-gdi5). Dropped the stale "ten PKM verbs" count (prompt + a claude_engine.py comment) so the sentence can't drift as tools are added.

Tests: test_assistant_policy.py asserts the citing guidance is present and that no spelled-out tool count reappears (word-boundary match — "ten" hides inside "written"). 824 server tests green, pyrefly + ruff clean.

Live smoke against a scratch server on 8975 with a prod-DB snapshot and the real Claude engine: "tell me about graphs related to environmental impact" now returns five charts, each as ![chart](/assets/<sha>/<file>) plus a ((uid)) block ref in the FIRST reply — rendered as expandable inline images with clickable block refs. No API, renderer, or web changes.
