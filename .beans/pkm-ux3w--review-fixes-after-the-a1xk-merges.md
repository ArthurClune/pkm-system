---
# pkm-ux3w
title: Review fixes after the a1xk merges
status: completed
type: bug
priority: normal
created_at: 2026-10-21T20:38:39Z
updated_at: 2026-10-21T21:50:10Z
parent: pkm-a1xk
---

Fixes from the final whole-branch review.

- [x] current-work now_ms overflow clamped, unit test, route in request-prop focus
- [x] reach floors in rename, no-500 request/stored/upstream props
- [x] spelled_or_canonical padded-spelling property with mutant
- [x] regexlint: bytes, pattern=/flags= keywords, format/% ; docs sentence; (?x)
- [x] split_heading strips one trailing newline
- [x] index_ref skips forbidden titles
- [x] halve two web floors

## Summary of Changes

- `/api/current-work` clamps its derived window bounds to the int64 range; unit test; the route joins the request property's focus set (the property did not draw the overflow in 12 seeds, so it was not shown to fail on the old code).
- Reach floors (half the lowest share over 20-24 seeds) in the rename, request, stored and upstream property files via `hostile.with_floors`; labels with under about ten events at the lowest seed have none, and the generators were changed to draw the required ones more often.
- New property: `rewrite_title_refs_map` with `spelled_or_canonical` over padded spellings; fails when `spelled_or_canonical` returns the raw spelling. The swap property now reaches texts mentioning both titles.
- regexlint follows bytes, `pattern=`, `flags=`, `.format` and `%`, and skips `#` comments in verbose patterns; docs name what it still misses.
- `split_heading` tolerates exactly one trailing newline.
- `index_ref` skips a forbidden title; rename with a legacy forbidden title in a block no longer 500s.
- Web floors: `hiddenFocus` 15 to 12; `midPair` stays 8 (already half its lowest count, 17).

Open: two pre-existing 500s the properties now find on some seeds (see the report): export.zip with a title macOS refuses as a filename, and a sibling shift past INT64_MAX storing a float `order_idx`.
