---
# pkm-9jwr
title: 'In-app help page: render docs/keyboard.md at a /help route'
status: in-progress
type: feature
priority: normal
created_at: 2026-07-22T18:49:57Z
updated_at: 2026-07-22T18:55:27Z
---

Surface the keyboard shortcut reference (docs/keyboard.md, added 2026-07-23) as a help page in the app. Needs: a route (e.g. /help or /help/keyboard) rendering the markdown through the app's existing render pipeline, the doc bundled or served so the SPA can load it, and an entry point in the UI (top-bar menu item and/or a shortcut). Keep docs/keyboard.md the single source of truth — the page should render that file, not a copy.

## Plan

- [x] TDD: functional-core markdown-subset parser (h1-h3, paragraphs, tables, backtick code spans) with tests
- [x] Help view rendering docs/keyboard.md via ?raw build-time import
- [x] /help route in App.tsx
- [x] TopBar help entry point
- [x] E2E: /help renders shortcut tables; entry point navigates
- [x] pnpm verify green

## Summary of Changes

- **Parser** (`web/src/help/parseHelpMarkdown.ts`, Functional Core): hand-rolled parser for exactly
  the markdown subset `docs/keyboard.md` uses — no markdown dependency, and deliberately not the
  app's block grammar (`grammar/tokenize.ts`), since the doc has literal `` `[[page]]` `` /
  `` `((…))` `` inside backticks that grammar would linkify. Produces `HelpBlock[]` of
  `{ kind: "heading", level: 1|2|3, inline }`, `{ kind: "paragraph", inline }`, and
  `{ kind: "table", header: Inline[], rows: Inline[][] }`, where `Inline = { code: boolean; text: string }[]`.
  One deviation from the plan's suggested shape: `header`/`rows` are one level shallower
  (`Inline[]` / `Inline[][]`, not `Inline[][]` / `Inline[][][]`) — the doc has no multi-row headers,
  and the flatter shape was simpler to render and test. Tables are found by a header line starting
  with `|` immediately followed by a `|---|` separator line; body rows are then any further
  `|`-prefixed lines. No pipe-escaping logic — checked `docs/keyboard.md` and no cell contains a
  literal `|`. Backtick code spans are split pairwise (`text.split("`")`, odd indices = code); every
  backtick in the doc is paired, so there's no unterminated-span case. A test parses the real doc
  and asserts every non-blank, non-separator-row word survives into the rendered output (parser
  round-trip test), plus targeted unit tests for headings/paragraph-joining/table+code-span parsing.
- **View** (`web/src/views/Help.tsx`, Imperative Shell): `docs/keyboard.md` is imported at module
  scope via `?raw` and parsed once (module-level constant, not per-render). Rendering is split into
  an exported `HelpBlocks({ blocks })` (pure, given parsed blocks) wrapped by `Help()` (sets
  `document.title`, holds the real doc's parsed blocks) — this let unit tests exercise rendering
  against small fixture markdown without depending on the real doc's content matching test
  expectations. Reuses the app's existing `.roam-table` / `.roam-table-scroll` / `.inline-code`
  classes for tables and code spans rather than introducing new ones.
- **Route**: `<Route path="/help" element={<Help />} />` added in `App.tsx` before the `*` NotFound
  route.
- **Top-bar entry point**: new `HelpCircleIcon` in `components/icons.tsx` (matches the existing
  16px/viewBox-24/stroke-1.8 icon convention). `TopBar.tsx` gets a `.help-button` icon button
  (`aria-label="help"`, `title="Keyboard shortcuts"`) navigating to `/help`, and `barLabel` now
  resolves `"Help"` on that route. `.help-button` was folded into the existing shared ghost-button
  CSS rule alongside `.top-bar-menu-button`/`.sidebar-toggle-button` (and the corresponding
  `styles.test.ts` "share one ghost style" assertion updated to match) rather than duplicating the
  style.
- **Styling**: `.help-page` rules added to `styles.css` — headings/paragraphs capped at a 640px
  readable width (tables stay full width for their columns), spacing consistent with the rest of
  the app's typographic scale, all via existing CSS custom properties (no hardcoded colors), so it
  matches both themes automatically.
- **Deviation not in the original plan**: `docs/keyboard.md?raw` reaches one directory above `web/`'s
  Vite project root, and Vite's dev/test server denies filesystem access outside the root by
  default ("Denied ID ... ?raw" in vitest). Added `server.fs.allow: [repoRoot]` to `vite.config.ts`
  (repo root computed via `fileURLToPath(new URL("..", import.meta.url))`) to fix this — needed for
  both `vitest` and any future `vite dev`/`vite preview` use of the Help view.
- **Tests added**: `web/src/help/parseHelpMarkdown.test.ts` (5 tests, incl. the real-doc round-trip),
  `web/src/views/Help.test.tsx` (2 tests: fixture-based `HelpBlocks` rendering incl. literal
  `[[page]]` rendering as `<code>` not a link, and the real `Help()` component rendering a known
  row + setting `document.title`), `web/e2e/help.spec.ts` (2 tests: direct `/help` navigation shows
  the heading and the Ctrl+Shift+D row; clicking the top-bar help button from the journal navigates
  to `/help`).
- **Verify**: `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis`, `pnpm test:coverage` (1407 tests,
  coverage 97.81%/92.52%/95.52%/97.81%, thresholds 95/91/89/95), `vite build` (bundle budgets OK),
  and the full Playwright suite (25 tests) all green. One `tooling/lintConfig.test.ts` timeout and
  one `e2e/link-reference.spec.ts` failure were observed on a first full run under load; both
  reproduced identically after `git stash`-ing all pkm-9jwr changes back to the unmodified branch,
  confirming they're pre-existing flakes unrelated to this feature, and a clean rerun after
  restoring the stash passed everything including those two.
