---
# pkm-lsfy
title: 'Multi-block selection: mouse drag + Shift+Click range'
status: scrapped
type: feature
priority: low
created_at: 2026-07-12T07:53:58Z
updated_at: 2026-07-12T08:03:06Z
---

Follow-up to pkm-9b8n, which shipped Shift+Arrow-only multi-block selection. Add the two deferred interaction methods: click-drag across blocks to select a range, and Shift+Click to select from the current block to the clicked one. Reuse the existing selection model (blockSelection.ts) and .selected highlight; only the gesture detection is new.

## Reasons for Scrapping

Won't do — the Shift+Arrow multi-block selection shipped in pkm-9b8n covers the need; mouse-drag and Shift+Click range selection aren't wanted.
