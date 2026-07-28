---
# pkm-hjcc
title: Assistant cites assets as clickable links in first pass
status: in-progress
type: feature
priority: normal
created_at: 2026-07-28T11:02:16Z
updated_at: 2026-07-28T11:06:48Z
---

SYSTEM_PROMPT tweak so first-pass answers cite assets by full /assets/<sha>/<filename> URL (rendered clickable by pkm-gdi5) and blocks as ((uid)); also de-drift the 'ten PKM verbs' count. Spec: docs/superpowers/specs/2026-07-28-assistant-first-pass-asset-links-design.md

## Tasks

- [x] SYSTEM_PROMPT: asset-URL + ((uid)) citing rules; remove tool count
- [x] test_assistant_policy.py: assert citing guidance present
- [x] pytest + pyrefly + ruff green
- [ ] Live smoke: first-pass answer carries clickable asset links
