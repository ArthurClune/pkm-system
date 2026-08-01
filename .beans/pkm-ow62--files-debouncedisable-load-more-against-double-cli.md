---
# pkm-ow62
title: 'Files: debounce/disable Load more against double-click duplicates'
status: todo
type: bug
priority: low
created_at: 2026-08-01T18:05:52Z
updated_at: 2026-08-01T18:05:52Z
parent: pkm-6phf
---

Found during pkm-3622 review (pre-existing, out of that bean's scope): the Load more button (web/src/views/Files.tsx:340-343) has no disabled/busy guard, so two rapid clicks before the first fetchPage resolves both capture the same generation and offset — both responses pass isStale and duplicate items get appended.

- [ ] Guard Load more against concurrent invocations (busy flag like Select all)
- [ ] Add a double-click regression test
