---
# pkm-y8hl
title: Keep session_secret out of the iCloud backup mirror
status: todo
type: task
priority: normal
created_at: 2026-10-27T10:46:59Z
updated_at: 2026-10-27T10:55:45Z
parent: pkm-mfd0
---

From the SECURITY.md review (2026-10-27, finding I6). deploy/icloud_backup.py mirrors the data directory into iCloud Drive daily; DEFAULT_EXCLUDES leaves out only the live pkm.sqlite3, its -wal/-shm and .DS_Store, so config.json goes too: session_secret (enough to mint a pkm_session via auth_core.sign_session) and the password's salt and scrypt hash. Arthur's ruling (2026-10-27): keep the secret out of the mirror. The notes and DB snapshots still go to iCloud by design.

- [ ] Decide the cut: exclude config.json, or mirror a copy without session_secret (the password hash and other settings are needed to restore)
- [ ] Restore path: a restored config without a secret mints a new one (every device logs in again once); deploy/README.md § restore says so
- [ ] Test in the icloud_backup tests: the mirror never holds session_secret
- [ ] Remove the existing config.json from the iCloud copy (and from any iCloud version history), then rotate session_secret AND change the password: the mirrored scrypt hash allows offline guessing (prod change: ask Arthur first; rotation logs every device out)
- [ ] SECURITY.md: drop or rewrite the iCloud row
- [ ] troubleshooting.md row
