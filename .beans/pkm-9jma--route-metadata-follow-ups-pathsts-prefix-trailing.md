---
# pkm-9jma
title: 'Route metadata follow-ups: paths.ts prefix, trailing-slash titles'
status: todo
type: task
priority: low
created_at: 2026-08-01T18:05:52Z
updated_at: 2026-08-01T18:05:52Z
parent: pkm-6phf
---

Follow-ups from pkm-77w2 reviews:
- web/src/paths.ts:10 hardcodes "/page/" which routeMeta.ts exports as PAGE_ROUTE_PREFIX; make paths.ts consume the constant (routeMeta.test.ts already pins the values equal).
- routeMetaFor is an exact string match, so a hand-typed trailing-slash URL like /files/ still routes but no longer gets a title update (previously the view's own mount effect set it). Decide whether to normalise the pathname before lookup.

- [ ] paths.ts consumes PAGE_ROUTE_PREFIX
- [ ] Trailing-slash pathname handling in routeMetaFor (or document as accepted)
