---
# pkm-vlkm
title: 'install.sh: bootstrap right after bootout fails with error 5 and leaves the server down'
status: todo
type: bug
created_at: 2026-10-06T11:12:01Z
updated_at: 2026-10-06T11:12:01Z
---

deploy/install.sh does `launchctl bootout` then immediately `launchctl bootstrap` for each job. bootout returns before the job is torn down, so on 2026-10-06 (pkm-fsty deploy) the server's bootstrap failed with 'Bootstrap failed: 5: Input/output error'; set -e aborted the script, leaving prod's server unloaded (backup jobs and the Tailscale Serve step never ran). A manual `launchctl bootstrap` a few seconds later worked.

Fix: after bootout, wait until `launchctl print gui/$UID/$LABEL` reports the service gone (bounded wait) before bootstrapping, or retry bootstrap briefly on failure. Keep set -e semantics for genuine failures.

- [ ] Wait for bootout to complete (or retry bootstrap) in install.sh
- [ ] Check deploy/README.md still describes install.sh correctly
