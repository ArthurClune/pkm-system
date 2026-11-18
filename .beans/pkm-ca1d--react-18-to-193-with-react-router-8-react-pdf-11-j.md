---
# pkm-ca1d
title: React 18 to 19.3 with react-router 8, react-pdf 11, jest-dom 7
status: in-progress
type: task
priority: normal
created_at: 2026-11-18T13:08:10Z
updated_at: 2026-11-18T13:24:17Z
parent: pkm-tcca
---

Part of pkm-tcca. React 18.3.1 has had no release since April 2024; 19.0-19.3 are all patched together. react-router 8 and react-pdf 11 require React 19, so they move in the same branch.

- [x] Bump react, react-dom 19.3, @types/react and @types/react-dom 19, react-router 8, react-pdf 11 (check its pdfjs-dist pin against PdfViewer's worker URL and publicHoistPattern), @testing-library/jest-dom 7
- [x] Typecheck clean (JSX namespace, ref callback returns, useRef argument, ReactElement props)
- [x] Behaviour changes checked: render errors no longer re-thrown (the root ErrorBoundary only renders a message; nothing relied on a rethrow), Suspense fallback commits before siblings (the app has no Suspense; react-pdf 11's is turned off), StrictMode memo reuse (dev only), Trusted Types no longer stringified (none used)
- [x] react-router 8 migration notes applied (library mode untouched by 8.0; its exports map now picks the production build, so the vite.config alias is gone)
- [x] Bundle and precache budgets re-checked
- [ ] pnpm verify green
- [ ] proptest/check.sh web
- [ ] perf/check.sh frontend (render counts expected to move; table to Arthur)

## Notes

- react-pdf 11 suspends by default and throws a failed load to the nearest
  error boundary, so PdfViewer's onLoadError fallback link and `loading` note
  would never show. Both Documents pass suspense={false}; the test mock now
  throws without it.
- React 19 replays no mount effects under a StrictMode that a wrapper
  component renders (RTL's `wrapper`), only under one at the root.
  useSocketLifecycle.test.ts used a wrapper, so "a StrictMode replay keeps the
  session" passed with no replay and "first socket closing late" failed with
  `expected false to be true` on `first.closedByApp`. It now passes
  `reactStrictMode: true` and asserts the replay happened.
- findBy*/waitFor run with React's act environment off; under React 19 a
  chained commit's effects could still be pending when the query resolved, so
  EditableSidebarPanel's flash test and PageView's seed test failed 2-15 runs
  in 20, and "writes nothing" assertions after a findBy could pass vacuously.
  test-setup.ts wraps RTL's asyncWrapper with an act() flush.
- Budgets (Arthur accepted both): initialEntryBytes 506800 -> 600000 (React 19
  runtime, entry 496635 -> 575542 raw, gzip 161 -> 183 kB);
  pdfjsOwnedBytes 486845 -> 680000, totalOutputBytes 9960149 -> 10590000,
  precacheBytes 9016813 -> 9660000 (pdf.js 6 via react-pdf 11: chunk
  421973 -> 650195, worker 1046214 -> 1271915).
