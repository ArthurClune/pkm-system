---
# pkm-fsty
title: Rotate production logs under ~/.config/pkm/logs
status: in-progress
type: task
priority: normal
created_at: 2026-10-06T09:01:28Z
updated_at: 2026-10-06T11:12:07Z
---

Production's launchd jobs write to `~/.config/pkm/logs/` (deploy/README.md: `server.{out,err}.log`, `backup.*`, `icloud-backup.*`) and nothing ever rotates them. On 2026-10-06 `server.out.log` was 12 MB and `server.err.log` 2 MB after about three months; backup logs are tiny. Growth is slow but unbounded, and a big file makes the server-log forensics in the prod recipe slower.

Constraint: launchd opens the `StandardOutPath`/`StandardErrorPath` files and holds the descriptors, so renaming a file (newsyslog's default) leaves the job writing to the renamed file until a restart, and macOS newsyslog has no copytruncate. Options to decide between:

1. The server logs to its own rotating handler (`TimedRotatingFileHandler`, daily, keep N days) and launchd's stdout/stderr carry only startup crashes.
2. A newsyslog.d entry (needs root to install) plus a service kickstart after rotation, or one keyed off the existing nightly backup job.
3. The nightly backup job copies and truncates the logs in place (truncate-in-place is safe for O_APPEND writers), keeping N dated copies.

Whatever is chosen: keep enough history for forensics (at least a couple of weeks), cover all three jobs' logs, and update deploy/README.md (layout, and how to find older logs) and the prod-host recipe's log-reading notes. Deploying it changes the prod service setup, so confirm with Arthur before installing.

- [x] Pick the mechanism (above), with the forensics retention
- [x] Implement and test (unit-test any pure retention or rotation logic)
- [x] deploy/README.md: layout and where older logs live
- [ ] Install on prod with Arthur's go-ahead; verify a rotation happened and the server kept logging

## Recommendation (2026-10-06)

Option 1, for the server logs: the server logs through its own TimedRotatingFileHandler (daily, keep about 30 days) under ~/.config/pkm/logs/, and launchd's StandardOutPath/StandardErrorPath carry only what escapes it (startup crashes, uncaught tracebacks). It needs no root, no kickstart after rotation, and nothing outside the app. The handler is configured where the server already sets up logging (and for uvicorn's access/error loggers too), with the path and retention from the existing settings/env pattern.

The backup and icloud-backup logs grow by a few KB a month (15 KB after three months), so they need nothing now; if they ever do, option 3 (the nightly job truncating its own log in place) suits them better than a handler.

Check before choosing: what writes server.out.log (uvicorn access lines vs app logging) — that sets which loggers the handler must take over so the launchd files really stop growing.


## Deployed (2026-10-06)

Merged at 23597323 and deployed: install.sh re-rendered the server plist with `--log-dir` (its bootstrap hit the race filed as pkm-vlkm; a manual bootstrap brought the server back after about a minute). Prod now writes `logs/server.log` and `logs/access.log`; launchd's `server.{out,err}.log` are empty. The old files are kept as `server.{out,err}.log.pre-rotation.gz`. A forced rollover across a restart was checked on a scratch server; the open item is seeing the first midnight rotation on prod (`ls ~/.config/pkm/logs/*.log.2026-10-06` on or after 2026-10-07).
