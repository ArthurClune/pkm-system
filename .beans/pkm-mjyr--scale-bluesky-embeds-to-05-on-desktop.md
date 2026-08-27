---
# pkm-mjyr
title: Scale Bluesky embeds to 0.5 on desktop
status: completed
type: feature
created_at: 2026-08-27T11:01:31Z
updated_at: 2026-08-27T11:01:31Z
---

Bluesky post embeds render too large on desktop. Use a transform:scale(0.5) wrapper (.bluesky-embed-box) so the iframe visually renders at half size (text included) while the layout box also collapses to half size, avoiding excess whitespace. Mobile (<=600px) stays full size. Approved design from team-lead; see BlueskyEmbed.tsx and styles.css.

## Summary of Changes

- `BlueskyEmbed.tsx`: wrapped the `<iframe className="bluesky-embed">` in a `<div className="bluesky-embed-box">`. The reported post height now goes onto the wrapper as an inline `--bluesky-height` CSS custom property instead of inline `style.height` on the iframe.
- `styles.css`: replaced the old fixed-size `.bluesky-embed` rule with a scale-compensating pair — `.bluesky-embed-box` is the real layout box (half width/height on desktop via `--bluesky-scale: 0.5`), and `.bluesky-embed` is laid out at `1/scale` of the box and visually shrunk with `transform: scale()`, so the iframe (including its text) renders at a true half size while the box collapses to match, avoiding excess whitespace. `@media (max-width: 600px)` resets `--bluesky-scale` to 1 for mobile.
- `BlueskyEmbed.test.tsx`: updated the two height-reporting tests to assert the `--bluesky-height` custom property on `.bluesky-embed-box` instead of inline iframe height; added a test asserting the iframe is wrapped in `.bluesky-embed-box`.
- No other files needed changes: `e2e/embeds.spec.ts` and `InlineSegments.test.tsx` only select `iframe.bluesky-embed`, which the iframe still carries; architecture docs only mention Bluesky embeds in passing (module list, diagram label) with no sizing detail to update.

Verified via `pnpm verify` from `web/`: typecheck, lint, FCIS boundary check (172 modules, no violations), unit tests (147 files / 2325 tests, all passing), coverage 98.16% statements, production build, and all 54 Playwright e2e specs — all passed on the first run, no flakes.
