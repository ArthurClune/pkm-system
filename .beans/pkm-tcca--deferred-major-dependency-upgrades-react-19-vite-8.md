---
# pkm-tcca
title: Deferred major dependency upgrades (React 19, vite 8, TypeScript 7 and others)
status: todo
type: epic
priority: low
created_at: 2026-11-17T20:07:08Z
updated_at: 2026-11-18T15:00:21Z
---

Majors left out of the 2026-11-17 dependency refresh (pkm-hujh, pkm-wp0f), each its own branch. No advisory in the shipped bundle depends on any of them (pnpm audit --prod and pip-audit were clean). mcp 2.x is not here: it went in with the server refresh (pkm-cxq5, reopened).

- [x] React 18 to 19.3 with @types/react(-dom) 19, react-router 8, react-pdf 11 (pdf.js 6) and jest-dom 7 (pkm-ca1d). Entry and pdf.js budgets raised (accepted); perf unchanged; PDF viewing now needs Safari/iPadOS 26.
- [x] vite 6 to 8, with @vitejs/plugin-react 6 and vite-plugin-pwa 2 (pkm-gxc3). A workbox-build>glob override, not vite-plugin-pwa 2, clears the glob and minimatch advisories. Rolldown's runtime chunk adds one cold-load request (H/cold 13 -> 14, accepted).
- [ ] TypeScript 5.9 to 7. Deferred (2026-11-18) until TS 7.1 is stable and typescript-eslint's tsgo backend is no longer experimental. Checked then: the typescript package from 7.0 exports no classic compiler API, and typescript-eslint 8.73 takes typescript <6.1, or an experimental tsgo backend (projectService.EXPERIMENTAL_backend) that needs classic 6.0 as typescript plus a 7.1 beta/dev build aliased as @typescript/native. A trial with 6.0.3 and 7.1.0-beta: tsc 7.1 and 7.0.2 typecheck every project clean (about 6x faster than 6.0); lint is clean on classic 6.0 and on tsgo, where lintConfig.test.ts and the brand tests pass (no lint speed gain). To re-check when taking it: tsgo rejects allowDefaultProject/defaultProject, so playwright.config.ts needs a tsconfig the project service finds; both packages ship a tsc bin, so typecheck must name its compiler; openapi-typescript 7.13 still peers typescript ^5; fcis.ts and genTypes-core.ts use the classic API and need classic typescript or a port.
- [ ] mermaid 11 to 12 (11.17.2 taken and 12 audited in pkm-7p38; 12 deferred: it bundles the 1.5 MB ELK layout engine, over the mermaid and precache budgets). It is pinned ~11.17.2 so that any bump forces the mermaidSafety mirror re-check against the new mermaid and dompurify.
- [x] katex 0.18 to 0.19 (pkm-adqc): re-check that it still refuses links and images. The katex override in pnpm-workspace.yaml must keep one katex install.
- [x] jsdom 26 to 31 for the unit suite (pkm-mfj7).
- [x] @playwright/test 1.61 to 1.65 (pkm-kyle). It is pinned exactly because 1.65 needs a newer cached browser.
- [x] websockets 16 to 17 on the server (pkm-3n8b). It is bounded <17 in server/pyproject.toml: only uvicorn's WS transport uses it, which pytest does not reach, so the check is the Playwright suite plus a live sync session.
- [ ] picomatch (high, ReDoS, reaching lint through typescript-eslint and tinyglobby) had no patched release on 2026-11-17; take it when one ships.
