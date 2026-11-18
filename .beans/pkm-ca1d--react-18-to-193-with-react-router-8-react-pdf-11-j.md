---
# pkm-ca1d
title: React 18 to 19.3 with react-router 8, react-pdf 11, jest-dom 7
status: completed
type: task
priority: normal
created_at: 2026-11-18T13:08:10Z
updated_at: 2026-11-18T14:08:05Z
parent: pkm-tcca
---

Part of pkm-tcca. React 18.3.1 has had no release since April 2024; 19.0-19.3 are all patched together. react-router 8 and react-pdf 11 require React 19, so they move in the same branch.

- [x] Bump react, react-dom 19.3, @types/react and @types/react-dom 19, react-router 8, react-pdf 11 (check its pdfjs-dist pin against PdfViewer's worker URL and publicHoistPattern), @testing-library/jest-dom 7
- [x] Typecheck clean (JSX namespace, ref callback returns, useRef argument, ReactElement props)
- [x] Behaviour changes checked: render errors no longer re-thrown (the root ErrorBoundary only renders a message; nothing relied on a rethrow), Suspense fallback commits before siblings (the app has no Suspense; react-pdf 11's is turned off), StrictMode memo reuse (dev only), Trusted Types no longer stringified (none used)
- [x] react-router 8 migration notes applied (library mode untouched by 8.0; its exports map now picks the production build, so the vite.config alias is gone)
- [x] Bundle and precache budgets re-checked
- [x] pnpm verify green
- [x] proptest/check.sh web (248 passed)
- [x] perf/check.sh frontend: no changes against the baseline (no count or timing moved; no rebaseline)

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
- Forward to a page lost its scroll offset (e2e history-scroll "back and
  forward restore each page's scroll offset": `Expected: 700 Received: 0`).
  react-router 8's BrowserRouter updates the location in startTransition, and
  React 19 commits a transition started in a popstate as soon as that listener
  returns, so useHistoryScrollRestore's popstate listener, added later in a
  useEffect, recorded the outgoing offset under the incoming key. Chromium
  ran the listeners in the order added despite the capture flag. The
  listeners are now added in a useLayoutEffect, which runs before
  BrowserRouter's (a parent) subscribes. jsdom cannot show the order, so the
  e2e spec is the regression test; the rule is in the hook's header.
- Browser floor: pdf.js 6's modern build calls
  `Map.prototype.getOrInsertComputed` and `Math.sumPrecise` with no polyfill
  (pdf.js 5.4 had neither). Chromium 159 and WebKit 27.2 have both, so PDF
  viewing needs iPadOS/Safari 26 or later; an older engine fails the load or
  leaves pages blank. Only pdf.js's legacy build polyfills them.
- Opus whole-branch review: merge, no code defect. Its doc and comment
  findings are applied: the popstate order rule in frontend.md § Scroll on
  back and forward (WebKit runs capture listeners first, so `capture: true`
  stays; Chromium orders by registration, hence the layout effect), the
  react-pdf 11 failure mode (a failed load reaches onLoadError, then is
  rethrown to the root ErrorBoundary), and the test-setup flush's edges.

## Summary of Changes

React 18.3.1 to 19.3.1 with @types/react(-dom) 19, react-router 8.5.1,
react-pdf 11.1.0 (pdf.js 6.5.438) and jest-dom 7.0.1. PdfViewer passes
suspense={false}; the vite.config alias that forced react-router's
production build is gone (its exports map does it); three type fixes.
Back/forward scroll restore adds its popstate listener in a layout effect
so it runs before react-router's (the e2e history-scroll regression). Tests:
StrictMode replay tests put StrictMode at the root, and RTL's async wrapper
ends with an act() flush. Budgets raised with Arthur's approval
(initialEntryBytes, pdfjsOwnedBytes, totalOutputBytes, precacheBytes).
Gates on the branch: pnpm verify green (7168 unit, 130 e2e),
proptest/check.sh web 248/248, perf/check.sh frontend no changes.
