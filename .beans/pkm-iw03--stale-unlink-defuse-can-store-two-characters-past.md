---
# pkm-iw03
title: Stale-unlink defuse can store two characters past the text cap
status: todo
type: bug
priority: low
created_at: 2026-10-25T03:18:21Z
updated_at: 2026-10-25T03:18:21Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf final re-review (2026-10-25). Outside the stale-edit replay, the stale-unlink path adds two backticks to defuse a leading attribute naming a page deleted while the client was offline; an at-cap (1,000,000 code point) text then stores at 1,000,002. Judge the defused text and land the conflict entry like the replay, or defuse without growing.

- [ ] Red test at the cap
- [ ] Fix
- [ ] troubleshooting.md row
