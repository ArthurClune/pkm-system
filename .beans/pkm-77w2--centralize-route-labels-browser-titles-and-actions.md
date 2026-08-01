---
# pkm-77w2
title: Centralize route labels, browser titles, and actions
status: todo
type: task
created_at: 2026-08-01T13:21:21Z
updated_at: 2026-08-01T13:21:21Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 13.

**References:** web/src/components/TopBar.tsx:20-29; web/src/App.tsx:179-187; title effects in web/src/views/CurrentWork.tsx, Journal.tsx, Files.tsx, Help.tsx, Settings.tsx, and PageView.tsx

Route declarations, top-bar labels, browser titles, and page-action recognition are maintained separately. /files and /settings already exist in the router but have no top-bar labels.

**Direction:** Define route metadata once and consume it from routing, TopBar, and one route-aware title effect, retaining dynamic page-title resolution for /page/*.

- [ ] Add route metadata consistency coverage
- [ ] Consolidate static route labels/titles/actions
