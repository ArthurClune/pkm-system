---
# pkm-4uv1
title: A PDF link in a query table cell or card embeds the whole PDF
status: completed
type: bug
priority: low
created_at: 2026-11-16T18:42:27Z
updated_at: 2026-11-16T19:44:56Z
---

A page attribute such as Local copy:: [paper.pdf](/assets/<sha>/paper.pdf) renders in a query's Table and Cards views as a full inline PdfEmbed, so that row or card grows to the height of the viewer. Seen with the synthetic graph's Paper/Measuring Garden Growth on Reading List. docs/architecture/frontend-rendering.md § PDF embeds and the viewer states when a link embeds, but says nothing about table cells or cards.

Spec: docs/superpowers/specs/2026-11-16-media-in-table-cells-design.md Plan: docs/superpowers/plans/2026-11-16-media-in-table-cells.md

- [x] Failing test for a PDF asset link in a query cell and card
- [x] Cell and card rendering
- [x] Rule stated in frontend-rendering.md


## Summary of Changes

Symptom: a `Local copy::` link to a PDF made its query-table row (or card) as tall as the inline PDF viewer; images, Bluesky posts, Mermaid diagrams, code blocks and nested queries did the same.

Cause: table cells rendered their value exactly as the outline does, embeds included.

Fix: under `CellMediaContext` (query Table/Cards cells and plain `{{table}}` body cells), `cellMedia` classifies each segment and `CellMediaLabel` replaces the embed with a one-line label. A PDF or image label opens the full-screen viewer over the table (Escape returns, focus on the label, view state kept); any other media label goes to the line that holds it (shift-click: sidebar). Nothing is fetched before the click. A jump to a plain-table cell finds it by `data-cell-uid` and flashes the `<td>`. The entry-chunk budget rose by the measured 1742 bytes.

Rule: docs/architecture/frontend-rendering.md § Media in table cells; frontend-editor.md § Tables for the click and key rules.
