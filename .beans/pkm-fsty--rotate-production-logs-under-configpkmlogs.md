---
# pkm-fsty
title: Rotate production logs under ~/.config/pkm/logs
status: todo
type: task
created_at: 2026-10-06T09:01:28Z
updated_at: 2026-10-06T09:01:28Z
---

Production's launchd jobs write to `~/.config/pkm/logs/` (deploy/README.md: `server.{out,err}.log`, `backup.*`, `icloud-backup.*`) and nothing ever rotates them. On 2026-10-06 `server.out.log` was 12 MB and `server.err.log` 2 MB after about three months; backup logs are tiny. Growth is slow but unbounded, and a big file makes the server-log forensics in the prod recipe slower.

Constraint: launchd opens the `StandardOutPath`/`StandardErrorPath` files and holds the descriptors, so renaming a file (newsyslog's default) leaves the job writing to the renamed file until a restart, and macOS newsyslog has no copytruncate. Options to decide between:

1. The server logs to its own rotating handler (`TimedRotatingFileHandler`, daily, keep N days) and launchd's stdout/stderr carry only startup crashes.
2. A newsyslog.d entry (needs root to install) plus a service kickstart after rotation, or one keyed off the existing nightly backup job.
3. The nightly backup job copies and truncates the logs in place (truncate-in-place is safe for O_APPEND writers), keeping N dated copies.

Whatever is chosen: keep enough history for forensics (at least a couple of weeks), cover all three jobs' logs, and update deploy/README.md (layout, and how to find older logs) and the prod-host recipe's log-reading notes. Deploying it changes the prod service setup, so confirm with Arthur before installing.

- [ ] Pick the mechanism (above), with the forensics retention
- [ ] Implement and test (unit-test any pure retention or rotation logic)
- [ ] deploy/README.md: layout and where older logs live
- [ ] Install on prod with Arthur's go-ahead; verify a rotation happened and the server kept logging
