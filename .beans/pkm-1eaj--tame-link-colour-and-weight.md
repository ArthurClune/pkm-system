---
# pkm-1eaj
title: Tame link colour and weight
status: todo
type: feature
priority: high
created_at: 2026-07-14T20:06:09Z
updated_at: 2026-07-14T20:06:09Z
parent: pkm-heod
---

Page links use the same saturated orange as the accent (--color-link = --color-accent = #ec6f35) at font-weight 600. Since most meaningful text in a PKM is a link, whole pages read orange+bold and the accent means nothing (worst on See Also-heavy pages like LLMs / Claude Code).

- [ ] Drop page-link weight to 500 (or normal); reserve bold for real emphasis
- [ ] Desaturate/darken --color-link slightly so it reads as "linked text" not "warning" (keep --color-accent as-is or split the tokens)
- [ ] Sidebar nav links: muted text colour by default, orange for hover and currently-active page (needs an active-route class on nav links)
- [ ] Check dark mode (#ff9d5c) gets the same treatment via tokens
- [ ] Verify visually on LLMs, Claude Code, AGI, Daily Notes in both themes
