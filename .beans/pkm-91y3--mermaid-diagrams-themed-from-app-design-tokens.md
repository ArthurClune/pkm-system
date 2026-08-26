---
# pkm-91y3
title: Mermaid diagrams themed from app design tokens
status: completed
type: feature
priority: normal
created_at: 2026-08-26T13:14:20Z
updated_at: 2026-08-26T13:49:18Z
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
- [x] Live visual check both themes (Arthur eyeballs — approved from screenshots 2026-08-26)

## Summary of Changes

- New functional core web/src/components/mermaidTheme.ts: mermaidThemeVariables(dark, token) maps design tokens onto mermaid base-theme variables (node fill/border/text, lineColor, backgrounds, cluster surfaces, app font stack at 14px). Empty-resolving tokens are omitted so mermaid derives its own values where styles.css is absent (jsdom).
- MermaidDiagram.tsx: initialize() now uses theme base + themeVariables resolved once via getComputedStyle at chunk load; currentMermaidTheme() became isDarkTheme(). Mount-time theme snapshot unchanged by design.
- 6 new tests (5 pure core, 1 shell initialize assertion; mockInitialize deliberately not reset — initialize fires once per test file). pnpm verify green; both themes verified live via scratch server + agent-browser screenshots.
- docs/architecture/frontend.md: mermaidTheme added to module map pure halves; theming note added.

Follow-up (separate bean, agreed with Arthur): evaluate beautiful-mermaid as renderer with mermaid fallback — better ELK layout, CSS-var live re-theming.
