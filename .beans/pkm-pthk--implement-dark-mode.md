---
# pkm-pthk
title: Implement Dark Mode
status: completed
type: task
priority: normal
created_at: 2026-07-09T20:57:32Z
updated_at: 2026-07-09T21:42:17Z
---

UI should offer dark mode, auto-switch based on system setting

## Summary of Changes

- `web/src/theme.ts` (Functional Core, new) + `theme.test.ts`: pure
  `ThemePreference` ("system" | "light" | "dark") logic — `isThemePreference`
  guard, `nextThemePreference` cycling, `resolveEffectiveTheme(preference,
  systemPrefersDark)`.
- `web/src/useTheme.ts` (Imperative Shell, new): hook wiring localStorage
  (key `pkm:theme`) and `matchMedia("(prefers-color-scheme: dark)")` to the
  pure logic; stamps `data-theme` (one of the three preference values, not
  just resolved light/dark) onto `<html>`.
- `web/src/components/ThemeToggle.tsx` + test (new): small button in the
  left nav (next to Search) that cycles system -> light -> dark on click,
  showing an icon + label for the current preference.
- `web/src/App.tsx`: wired `<ThemeToggle />` into the left nav.
- `web/src/styles.css`: full refactor from hard-coded hex colors to CSS
  custom properties on `:root` (light palette, pixel-identical to the old
  theme) plus a dark palette applied two ways so both paths work with the
  explicit choice always winning: `@media (prefers-color-scheme: dark)`
  scoped to `:not([data-theme="light"])`, and `:root[data-theme="dark"]`.
  Covers every color in the file, including the newer left-nav/autocomplete/
  search-modal/reconnect-banner rules. Also added explicit background/text
  colors to a few previously browser-default form controls (search input,
  composer textarea/send button, hamburger) — needed so they don't stay
  white in dark mode; the light-mode values match the vars so this is not a
  visible change there.
- highlight.js theming: dropped the `highlight.js/styles/github.css` import
  from `CodeBlock.tsx` (Vite CSS imports are global, so importing both
  github.css and github-dark.css would just fight over the cascade).
  Instead the `.hljs-*` token-color rules were copied into `styles.css` as
  `--hljs-*` custom properties (light values from github.css, dark from
  github-dark.css), varying with the theme like everything else. Documented
  in a comment in `CodeBlock.tsx`.
- Anti-flash: inline `<script>` in `web/index.html`, before the stylesheet
  link, reads `pkm:theme` from localStorage and stamps `data-theme` early
  only for explicit "light"/"dark". Plain "system" needs no JS at all —
  the CSS media query alone renders correctly on first paint. No CSP in
  this repo, so the inline script is unrestricted.
- Test infra: this Node 26 + jsdom combination has a broken global
  `localStorage` (Node's own experimental accessor shadows jsdom's,
  returning `undefined` without a `--localstorage-file` flag) and no
  `matchMedia` at all. Added `FakeLocalStorage`/`FakeMediaQueryList`/
  `stubMatchMedia` to `test-helpers.ts` and installed them in
  `test-setup.ts`'s `beforeEach` (not just once) since some test files call
  `vi.unstubAllGlobals()` in their own `afterEach`, which would otherwise
  also wipe these out.
- `pnpm vitest run` (31 files, 191 tests), `pnpm typecheck`, and `pnpm
  build` all pass.
