---
# pkm-as1l
title: allow hyphens while typing slash commands
status: completed
type: bug
priority: normal
created_at: 2026-07-26T18:45:37Z
updated_at: 2026-07-26T18:46:49Z
---

SLASH_QUERY_RE only accepts letters+digits, so typing a hyphen (e.g. /query-and) closes the slash menu; users must type /query and arrow-pick. Allow hyphens after the first letter so hyphenated command names can be typed in full. Found while documenting pkm-by0s.

## Summary of Changes

SLASH_QUERY_RE in web/src/outline/autocomplete.ts now accepts hyphens after the leading letter, so /query-and, /query-or, /query-and-not can be typed in full without the menu closing. Leading digits still stay quiet (/2020-01 in prose is inert), and a hyphenated non-command like /on-site leaves the context open but matches nothing — no popup renders and no keys are swallowed (key handling gates on acRowsLength > 0). Updated autocomplete.test.ts (the old /py-thon-closes assertion now expects the context open; new hyphen cases added) and softened the help-page caveat in docs/keyboard.md. 1474 unit tests + typecheck pass.
