---
# pkm-d5re
title: Surface page deletion failures in TopBar
status: todo
type: bug
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-17T20:55:24Z
parent: pkm-wvvu
---

## Review finding

Frontend correctness-adjacent flag: a confirmed page deletion that fails is swallowed, the menu closes, and the user receives no indication that the page remains.

## Acceptance criteria

- [ ] Keep the failed page visible and surface an actionable deletion error through TopBar or the confirmation flow
- [ ] Clear or supersede stale errors on a later attempt/navigation as appropriate
- [ ] Preserve successful deletion navigation and menu behavior
- [ ] Add component coverage for success, failure, retry, and accessible error announcement
- [ ] Reuse an existing application error pattern rather than inventing a second notification system
