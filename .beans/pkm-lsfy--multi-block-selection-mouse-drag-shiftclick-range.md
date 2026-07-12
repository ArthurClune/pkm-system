---
# pkm-lsfy
title: 'Multi-block selection: mouse drag + Shift+Click range'
status: todo
type: feature
priority: low
created_at: 2026-07-12T07:53:58Z
updated_at: 2026-07-12T07:53:58Z
---

Follow-up to pkm-9b8n, which shipped Shift+Arrow-only multi-block selection. Add the two deferred interaction methods: click-drag across blocks to select a range, and Shift+Click to select from the current block to the clicked one. Reuse the existing selection model (blockSelection.ts) and .selected highlight; only the gesture detection is new.
