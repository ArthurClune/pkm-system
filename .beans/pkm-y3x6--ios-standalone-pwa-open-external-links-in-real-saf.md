---
# pkm-y3x6
title: 'iOS standalone PWA: open external links in real Safari via x-safari- scheme'
status: completed
type: feature
priority: normal
created_at: 2026-08-28T17:34:30Z
updated_at: 2026-08-28T17:45:15Z
---

When the PKM web app runs as an installed home-screen app on iPhone/iPad, external links open in the iOS in-app browser overlay instead of full Safari. Apple provides no supported way to change this; the undocumented x-safari-https:// URL scheme (works iOS 17+, no-op on older iOS) opens the URL in the real Safari app.

## Design (decided with Arthur: interceptor, not href rewrite)

- Hrefs stay canonical https:// everywhere (copy link, share, non-iOS unaffected).
- One delegated capture-phase document click listener, mounted only when running as iOS standalone, rewrites the navigation at click time.

## Plan

- [x] Core `web/src/externalLink.ts` (Functional Core): iOS-standalone predicate taking navigator-shaped input; decide-and-transform for click targets (external origin, http/https only, plain left-click only) -> x-safari-http(s) URL or null
- [x] Shell `web/src/components/ExternalLinkInterceptor.tsx` (Imperative Shell, null-rendering like UndoRedoKeys): capture-phase document click listener; preventDefault + navigate to scheme URL; mounted in App.tsx next to UndoRedoKeys
- [x] Unit tests co-located (TDD), meeting coverage thresholds
- [x] pnpm verify green
- [x] frontend.md module map + prose note on the undocumented scheme (why it exists, iOS<17 no-op)

## Notes

- x-safari-https is undocumented; if Apple removes it, taps on external links in standalone would no-op. Revert = unmount one component.
- On iOS <17 the scheme is unrecognised and the click does nothing; accepted trade-off (Arthur's devices are current).

## Summary of Changes

- `web/src/externalLink.ts` (Core): `isIosStandalone(nav)` — iOS-family platform check (`iPhone|iPad|iPod`, or `MacIntel` + `maxTouchPoints > 1` for modern iPadOS) AND `navigator.standalone === true`. `safariHrefForClick(href, currentOrigin, modifiers)` — pure decision returning the `x-safari-http(s)://` URL or `null` for non-parseable URLs, same-origin URLs, non-http(s) protocols (mailto:, javascript:), and modified/non-primary clicks.
- `web/src/components/ExternalLinkInterceptor.tsx` (Shell): null-rendering component (modeled on `UndoRedoKeys`) that attaches a capture-phase `document` click listener only when `isIosStandalone(window.navigator)` is true at mount. Finds the clicked anchor via `closest("a[href]")`, defers to the core decision function, and on a match calls `e.preventDefault()` plus an injectable `navigate` prop (default `window.location.assign`). Does not `stopPropagation`.
- Mounted `<ExternalLinkInterceptor />` in `web/src/App.tsx` next to `<UndoRedoKeys />`.
- Tests: `web/src/externalLink.test.ts` (21 cases) and `web/src/components/ExternalLinkInterceptor.test.tsx` (9 cases), covering the standalone predicate's platform/touch/standalone branches and the interceptor's rewrite/same-origin/modifier-key/non-anchor/defaultPrevented/unmount paths. `externalLink.ts` reaches 100% coverage; the untested three-line `defaultNavigate` default in the shell (real `window.location.assign`, which jsdom cannot stub — confirmed by probing `vi.spyOn(window.location, "assign")`, which throws "Cannot redefine property") does not push the project-wide thresholds below their floors (98.14/94.16/95.63/98.14 statements/branches/functions/lines vs required 95/91/89/95).
- Docs: `docs/architecture/frontend.md` — added both modules to the module map and a new "External links in the iOS standalone app" prose note explaining the mechanism, the click-time-not-href-rewrite design, and the iOS<17 no-op.
- `CI=true pnpm verify` (typecheck, lint, check:fcis, coverage, build, Playwright e2e) passes clean: 149 test files / 2356 unit tests / 54 e2e tests, all green.
- No deviations from the brief.
