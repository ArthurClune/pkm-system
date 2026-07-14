---
# pkm-1eaj
title: Tame link colour and weight
status: completed
type: feature
priority: high
created_at: 2026-07-14T20:06:09Z
updated_at: 2026-07-14T20:17:21Z
parent: pkm-heod
---

Page links use the same saturated orange as the accent (--color-link = --color-accent = #ec6f35) at font-weight 600. Since most meaningful text in a PKM is a link, whole pages read orange+bold and the accent means nothing (worst on See Also-heavy pages like LLMs / Claude Code).

- [x] Drop page-link weight to 500 (or normal); reserve bold for real emphasis
- [x] Desaturate/darken --color-link slightly so it reads as "linked text" not "warning" (keep --color-accent as-is or split the tokens)
- [x] Sidebar nav links: muted text colour by default, orange for hover and currently-active page (needs an active-route class on nav links)
- [x] Check dark mode (#ff9d5c) gets the same treatment via tokens
- [x] Verify visually on LLMs, Claude Code, AGI, Daily Notes in both themes

## Summary of Changes

- Split link colour from the accent: light `--color-link` #ec6f35 -> #c25a28, dark #ff9d5c -> #e8935a; `--color-accent` unchanged.
- `a.page-link` now font-weight 500 (global `a` stays 600 for external links).
- `.nav-link` muted (`--color-text-secondary`, weight 500) with accent on hover and `.active`; Daily Notes + sidebar entries switched to react-router NavLink for the active class.
- Verified on all four sample pages in light and dark against a copy of prod data.
