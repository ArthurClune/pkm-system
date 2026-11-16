---
# pkm-4uv1
title: A PDF link in a query table cell or card embeds the whole PDF
status: in-progress
type: bug
priority: low
created_at: 2026-11-16T18:42:27Z
updated_at: 2026-11-16T19:24:10Z
---

A page attribute such as Local copy:: [paper.pdf](/assets/<sha>/paper.pdf) renders in a query's Table and Cards views as a full inline PdfEmbed, so that row or card grows to the height of the viewer. Seen with the synthetic graph's Paper/Measuring Garden Growth on Reading List. docs/architecture/frontend-rendering.md § PDF embeds and the viewer states when a link embeds, but says nothing about table cells or cards.

Spec: docs/superpowers/specs/2026-11-16-media-in-table-cells-design.md Plan: docs/superpowers/plans/2026-11-16-media-in-table-cells.md

- [ ] Failing test for a PDF asset link in a query cell and card
- [ ] Cell and card rendering
- [ ] Rule stated in frontend-rendering.md
