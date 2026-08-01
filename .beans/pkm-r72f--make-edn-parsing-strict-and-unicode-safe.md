---
# pkm-r72f
title: Make EDN parsing strict and Unicode-safe
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 19).

## Context

**References:** `server/src/pkm/edn.py:97-113,120-141`

Unsupported string/character escapes can be silently changed, surrogate-pair escapes produce invalid Python strings, truncated Unicode escapes leak raw ValueError, and discard forms at collection ends are rejected. Silent text corruption is worse than a clear import failure.

**Direction:** Validate escape names and hex length, combine/reject surrogates correctly, normalize parser errors to EdnError, and model discard forms at collection-parser level.

## Tasks

- [ ] Add unknown/truncated/lone-surrogate/supplementary-codepoint tests
- [ ] Add collection-end discard tests
- [ ] Reject unsupported forms without altering text
