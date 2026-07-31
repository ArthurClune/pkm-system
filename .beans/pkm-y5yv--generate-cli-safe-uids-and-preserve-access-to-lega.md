---
# pkm-y5yv
title: Generate CLI-safe UIDs and preserve access to legacy leading-dash UIDs
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:51Z
updated_at: 2026-07-31T15:54:51Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 6.

**References:** server/src/pkm/client/api.py:55-56; server/src/pkm/server/ops_core.py:15; server/src/pkm/cli/main.py:475-476,521-525

secrets.token_urlsafe() can generate a UID beginning with -. The server accepts it, but argparse interprets it as an option, so the CLI can create blocks it cannot subsequently address normally. This also makes write tests probabilistically flaky.

**Direction:** Generate UIDs with an alphanumeric first character. Preserve access to existing leading-dash UIDs through documented -- handling or an explicit --uid option and plan any regex tightening compatibly.

- [ ] Add deterministic leading-dash parser and end-to-end tests
- [ ] Make new UID generation CLI-safe
- [ ] Document or implement access to legacy UIDs
