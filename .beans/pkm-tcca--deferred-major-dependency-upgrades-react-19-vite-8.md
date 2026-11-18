---
# pkm-tcca
title: Deferred major dependency upgrades (React 19, vite 8, TypeScript 7 and others)
status: todo
type: epic
priority: low
created_at: 2026-11-17T20:07:08Z
updated_at: 2026-11-17T21:54:54Z
---

Majors left out of the 2026-11-17 dependency refresh (pkm-hujh, pkm-wp0f), each its own branch. No advisory in the shipped bundle depends on any of them (pnpm audit --prod and pip-audit were clean). mcp 2.x is not here: it went in with the server refresh (pkm-cxq5, reopened).

- [ ] React 18 to 19, with @types/react and @types/react-dom 19, @testing-library/jest-dom 7, react-pdf 11 (its pdfjs-dist pin and the publicHoistPattern in pnpm-workspace.yaml) and react-router 7 to 8. Perf baselines (renders) will move.
- [ ] vite 6 to 8, with @vitejs/plugin-react 6 and vite-plugin-pwa 2. vite-plugin-pwa 2 is what clears the glob and minimatch advisories that reach the build through workbox-build. Bundle and precache budgets need re-checking.
- [ ] TypeScript 5.9 to 7, checking typescript-eslint and the eslint brand rules support it.
- [ ] mermaid 11 to 12 (11.17.2 taken and 12 audited in pkm-7p38; 12 deferred: it bundles the 1.5 MB ELK layout engine, over the mermaid and precache budgets). It is pinned ~11.17.2 so that any bump forces the mermaidSafety mirror re-check against the new mermaid and dompurify.
- [x] katex 0.18 to 0.19 (pkm-adqc): re-check that it still refuses links and images. The katex override in pnpm-workspace.yaml must keep one katex install.
- [x] jsdom 26 to 31 for the unit suite (pkm-mfj7).
- [x] @playwright/test 1.61 to 1.65 (pkm-kyle). It is pinned exactly because 1.65 needs a newer cached browser.
- [ ] websockets 16 to 17 on the server. It is bounded <17 in server/pyproject.toml: only uvicorn's WS transport uses it, which pytest does not reach, so the check is the Playwright suite plus a live sync session.
- [ ] picomatch (high, ReDoS, reaching lint through typescript-eslint and tinyglobby) had no patched release on 2026-11-17; take it when one ships.
