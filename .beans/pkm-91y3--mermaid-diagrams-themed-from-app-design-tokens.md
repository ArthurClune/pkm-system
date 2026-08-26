---
# pkm-91y3
title: Mermaid diagrams themed from app design tokens
status: in-progress
type: feature
priority: normal
created_at: 2026-08-26T13:14:20Z
updated_at: 2026-08-26T13:25:33Z
---

Mermaid renders with its stock default/dark theme (Trebuchet MS, pale purple fills). Switch MermaidDiagram's initialize() to theme: 'base' with themeVariables derived from the app's CSS design tokens, read via getComputedStyle at load time.

Step 1 of 2 agreed with Arthur (step 2, a separate bean later, is swapping the renderer to beautiful-mermaid with mermaid fallback). Out of scope here: live re-theming on light/dark flip — mount-time snapshot stays, step 2 fixes it properly.

## Design
- New functional core web/src/components/mermaidTheme.ts: mermaidThemeVariables(dark, token) -> themeVariables object (fontFamily = app stack, node fill/border/text, lineColor, backgrounds, cluster surfaces, darkMode flag)
- MermaidDiagram.tsx shell builds token lookup from getComputedStyle(document.documentElement) and passes result to mermaid.initialize()

## Todo
- [x] TDD: unit tests for mermaidThemeVariables (light/dark mapping, token lookup used)
- [x] TDD: MermaidDiagram.test.tsx asserts initialize gets theme 'base' + themeVariables
- [x] Implement mermaidTheme.ts + wire into MermaidDiagram.tsx
- [x] pnpm verify green
- [ ] Live visual check both themes (Arthur eyeballs)
