---
# pkm-uwo5
title: Float the {{toc}} on the right of the main page
status: in-progress
type: feature
priority: normal
created_at: 2026-11-18T18:34:18Z
updated_at: 2026-11-18T18:48:38Z
---

On a page with a {{toc}} block, show the contents in a sticky column on the right of the main pane while the right sidebar is closed and the pane has room; the {{toc}} block then shrinks to a marker. When the sidebar opens (or the pane is too narrow, or the page is in a sidebar panel) the floating contents hides and the block shows the full card again. Spec: docs/superpowers/specs/2026-11-18-floating-toc-design.md

- [x] Spec approved
- [x] Plan: docs/superpowers/plans/2026-11-18-floating-toc.md
- [ ] Implementation (TDD)
- [ ] Docs (frontend-rendering.md, styling.md as needed)
- [ ] pnpm verify, perf/check.sh frontend
