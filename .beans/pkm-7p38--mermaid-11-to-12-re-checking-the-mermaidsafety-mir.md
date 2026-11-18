---
# pkm-7p38
title: mermaid 11.16 to 11.17.2, re-checking the mermaidSafety mirrors; 12 deferred for its size
status: in-progress
type: task
priority: normal
created_at: 2026-11-18T10:55:36Z
updated_at: 2026-11-18T11:06:21Z
parent: pkm-tcca
---

Part of pkm-tcca. mermaid is pinned ~11.16.1 so that a bump forces the mirror re-check in web/src/components/mermaidSafety.ts against the new mermaid and dompurify.

- [x] Bump mermaid (keep a ~ pin) and dompurify; one katex install still
- [x] Re-check each mirrored rule against the installed mermaid's source
- [x] Look for fetch paths new in 12 (shapes, icons, new diagram types, config keys reaching CSS)
- [x] external-media.spec probes show no outbound request; pnpm verify green

## Summary of Changes

mermaid ~11.16.1 to ~11.17.2 (dompurify stays 3.4.17, katex stays one install
at 0.19.1 through the override). mermaid 12 was audited and deferred.

**mermaid 12.3.0 audit (not taken).** Every function mermaidSafety.ts mirrors
(sanitize, sanitizeDirective, sanitizeCss, sanitizeDictionaryConfig,
encodeEntities, decodeEntities, assignWithDepth, addDirective) is byte-identical
to 11.16.1. The one config change, per-diagram-type theme/look/layout
(resolveAppearance), resolves theme only to built-in themes and derives theme
variables from initialize's. sanitize still deletes secure keys at every depth,
so a per-diagram section cannot carry themeVariables. The new error diagram
writes the parse error with d3 .text(). Icons load only from packs the app
registers (none). Image sites: the shape-data img (refused) and sequence actor
icons (refused); C4 no longer draws images. Deferred because 12 bundles the ELK
layout engine as its default: a 1.5 MB chunk that, with mermaid fully
precached, put mermaidOwnedBytes 1.79 MB and precache 1.7 MB over budget.
Arthur chose to stay on 11.x; taking 12 needs either a budget decision or ELK
kept out of the build.

**mermaid 11.17.2 re-check.** The same functions, plus updateCurrentConfig and
the icon-pack loaders, are byte-identical to 11.16.1. C4 no longer draws images,
so the image sites are the two refused ones above. The secure-default unit test
passes; external-media.spec's four diagram probes fetch nothing.

Verification: pnpm verify green (7168 unit, 130 Playwright); budgets OK.
