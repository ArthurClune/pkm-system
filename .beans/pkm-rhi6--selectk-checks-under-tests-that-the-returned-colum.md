---
# pkm-rhi6
title: select<K> checks under tests that the returned columns cover K
status: todo
type: task
created_at: 2026-10-19T09:13:28Z
updated_at: 2026-10-19T09:13:28Z
---

Split from pkm-78r0 (its Optional item).

`select<K>` is type-only: a K naming a column the SQL does not return types it as present. Under tests, check that the returned columns cover K (needs the keys at runtime, e.g. a keys argument). Medium cost: ~130 call sites.

- [ ] Decide the runtime key check and its call-site shape
- [ ] Migrate the call sites
