---
# pkm-iruc
title: Server-made conflict blocks embed uncapped page titles
status: in-progress
type: bug
priority: low
created_at: 2026-10-25T02:14:31Z
updated_at: 2026-10-25T09:52:34Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf Task 3 review (2026-10-25). Conflict blocks the server makes ([[conflict]] [[Page]] headers, copied legacy text) are not judged; headers embed page titles, which have no length cap, and copies carry legacy over-limit text. Judge them with the rewrite rule or cap title length.

- [ ] Decide: title length cap vs judging server-made conflict text
- [ ] Tests
- [ ] troubleshooting.md row
