---
# pkm-1vq4
title: embedded image size
status: completed
type: feature
priority: normal
created_at: 2026-07-29T20:41:40Z
updated_at: 2026-07-30T10:31:58Z
---

Embedded images should be shown at ~2/3 of their current size on a page

## Decision

"2/3 of current size" = cap the width at two-thirds of the text column
(`max-width: 67%`), not a scale factor on the intrinsic size. An image already
narrower than that keeps its natural size; nothing is upscaled. Phones (the
existing `max-width: 600px` breakpoint) keep the full column width -- two
thirds of an already-narrow column is too small to read.

## Implementation

- [x] `.asset-image` and `.asset-image-trigger` both capped at 67%: an external
      URL renders as a bare `<img>`, an uploaded `/assets/` image is wrapped in
      the expansion trigger, so whichever box is outermost must carry the cap
- [x] `.asset-image-trigger .asset-image` reset to `max-width: 100%` -- two
      nested 67% caps would multiply to 4/9 of the column
- [x] phone override after those rules (a media query adds no specificity, so
      source order is what wins)
- [x] `styles.test.ts`: cap, the no-double-cap reset, and the phone override;
      needed a `mediaRulesFor` helper because `ruleFor`/`rulesFor` stop at the
      first `}` inside an `@media` block
- [x] the trigger's `max-width` assertion moved out of the pkm-aze9 test

## Verification

`pnpm verify` green (typecheck, lint, fcis, unit coverage, build, 46 E2E).
Measured in a real browser against a scratch server, 1200x600 upload plus a
512px bare `<img>`:

| viewport | column | wrapped image | bare image |
|---|---|---|---|
| 1440 | 1021 | 684 (= 2/3) | 512 (natural, under the cap) |
| 700 | 297 | 199 (= 2/3) | 199 (= 2/3) |
| 390 | 306 | 306 (full) | 306 (full) |

The 684 figure is the one that matters: a double-applied cap would have been
458.
