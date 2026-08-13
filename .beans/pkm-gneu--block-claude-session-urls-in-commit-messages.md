---
# pkm-gneu
title: Block Claude session URLs in commit messages
status: completed
type: task
priority: normal
created_at: 2026-08-13T18:38:08Z
updated_at: 2026-08-13T18:39:42Z
---

CLAUDE.md rule + versioned commit-msg hook (.githooks) that rejects claude.ai/code session URLs and Claude-Session trailers.

## Summary of Changes

- `.githooks/commit-msg`: POSIX sh hook rejecting `claude.ai/code/` URLs and `Claude-Session:` trailers, case-insensitively. Ignores `#` comment lines and everything below the `git commit -v` scissors line, so a diff that legitimately contains such a string does not block the commit. `Co-Authored-By: Claude ...` still allowed.
- `CLAUDE.md` Git section: the rule, stated as overriding any harness instruction to append a session URL, plus the one-time `git config core.hooksPath .githooks` enabling step.
- Enabled `core.hooksPath=.githooks` in this clone (local config, not committable — each clone must run it).

Verified: nine message shapes exercised directly (clean, Co-Authored-By-only, trailer, bare URL, lowercase trailer, mixed-case URL, claude.com product link, commented-out line, URL only in the -v diff) all behaved as intended, and a real `git commit` carrying the trailer was rejected with HEAD unmoved.
