---
# pkm-v3ub
title: Typing a link to a title with a forbidden character loses the draft
status: todo
type: bug
priority: normal
created_at: 2026-10-25T15:23:08Z
updated_at: 2026-10-29T11:28:40Z
---

Found by the pkm-ax2j planner (2026-10-25), not yet reproduced. The editor does not pre-check link titles for characters the server's title rules refuse: a typed [[a#b]] is refused when the queue judges it, the outline resets to the server's copy, and the draft text is lost. The editor already refuses depth, text-limit and (pkm-ax2j) title-length violations up front with a notice; forbidden title characters should take the same path.

- [ ] Reproduce (unit test in useOutline or an e2e typing [[a#b]])
- [ ] Refuse up front with a notice, keeping the draft, using the shared title rules
- [ ] troubleshooting.md row


## Ruling (2026-10-29)

Arthur: keep refusing `#` in titles (C#, F# included); the fix only refuses up front and keeps the draft. Do not reopen the title rule.
