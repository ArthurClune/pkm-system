---
# pkm-n4s5
title: 'PDF viewer: Expand should preserve reading position'
status: todo
type: task
priority: low
created_at: 2026-07-16T18:02:14Z
updated_at: 2026-07-16T18:02:14Z
---

Follow-up from pkm-srek final review (plan-accepted simplification). Expanding to the fullscreen overlay restarts at page 1 (the overlay's PdfPages mounts fresh, scrollTop=0); collapsing likewise loses the inline scroll position. Seed the overlay's initial scroll from currentPage (and optionally restore on collapse).
