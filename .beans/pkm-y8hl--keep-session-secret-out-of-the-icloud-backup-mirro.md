---
# pkm-y8hl
title: Keep session_secret out of the iCloud backup mirror
status: completed
type: task
priority: normal
created_at: 2026-10-27T10:46:59Z
updated_at: 2026-10-29T11:28:58Z
parent: pkm-mfd0
---
From the SECURITY.md review (2026-10-27). deploy/icloud_backup.py mirrored the whole data directory into iCloud Drive daily, config.json included, so the mirror held session_secret (enough to mint a pkm_session). Arthur's ruling (2026-10-27): keep the secret out of the mirror. The notes and DB snapshots still go to iCloud by design.

- [x] Decide the cut: mirror config.json with session_secret removed; every other key is kept, for restore
- [x] Restore path: `restore` writes a new secret (every device logs in again once); deploy/README.md says so
- [x] Tests: server/tests/test_icloud_backup.py; no secret bytes anywhere under the destination
- [x] (Moved to pkm-tkgs by Arthur's ruling 2026-10-29) Operational follow-up for the existing mirror
- [x] SECURITY.md: the iCloud row rewritten generically (public-repo ruling, 2026-10-29)
- [x] troubleshooting.md row

## Summary of Changes

- `deploy/icloud_backup.py` (`redact_config`, `Guard`): config.json (matched case-insensitively at the top level) is mirrored with `session_secret` removed, and the manifest records the redacted size so restore's size check holds. Any other data file whose bytes contain the live secret (either hex case, streamed with chunk overlap) is refused loudly: stderr, a `PARTIAL` stdout line, exit 1. Only a 64-hex secret arms the guard; an odd hand-edited one warns and skips it. Symlinks are skipped with a stderr line. An unreadable or unparsable config is left out (the previous day's entry carried forward), the rest of the backup still runs, exit 1. `restore` writes a fresh secret, mode 0600, after verification.
- 37 tests in `server/tests/test_icloud_backup.py`, including a `/usr/bin/python3` (3.9) run and the upgrade from a mirror without config entries.
- Docs: deploy/README.md (restore, upgrade note), docs/SECURITY.md, docs/troubleshooting.md.

Rulings:
- Arthur: the repo is public; docs, comments and beans describe the mechanism only, never the real deployment's credentials.
- Arthur: fix round 3 (fail closed when the secret is unknown, staged copy check) dropped: the notes are in the mirror anyway, so the secret adds little exposure; backup completeness matters more.
- Review: name-based look-alike excludes removed in favour of the content guard (they silently dropped files such as config.jsonl).
