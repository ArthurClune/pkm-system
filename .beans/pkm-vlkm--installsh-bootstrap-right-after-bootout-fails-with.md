---
# pkm-vlkm
title: 'install.sh: bootstrap right after bootout fails with error 5 and leaves the server down'
status: completed
type: bug
priority: normal
created_at: 2026-10-06T11:12:01Z
updated_at: 2026-10-06T11:15:21Z
---

deploy/install.sh does `launchctl bootout` then immediately `launchctl bootstrap` for each job. bootout returns before the job is torn down, so on 2026-10-06 (pkm-fsty deploy) the server's bootstrap failed with 'Bootstrap failed: 5: Input/output error'; set -e aborted the script, leaving prod's server unloaded (backup jobs and the Tailscale Serve step never ran). A manual `launchctl bootstrap` a few seconds later worked.

Fix: after bootout, wait until `launchctl print gui/$UID/$LABEL` reports the service gone (bounded wait) before bootstrapping, or retry bootstrap briefly on failure. Keep set -e semantics for genuine failures.

- [x] Wait for bootout to complete (or retry bootstrap) in install.sh
- [x] Check deploy/README.md still describes install.sh correctly


## Summary of Changes

Reproduced on a throwaway launchd job whose SIGTERM handler takes 3s: `bootout` returned in 9ms, `launchctl print` still showed the job, and an immediate `bootstrap` failed with 5. `install.sh` now calls `wait_unloaded` between bootout and bootstrap: it polls `launchctl print` every 0.2s until the job is gone, failing after 30s (launchd SIGKILLs 20s after SIGTERM). The function, extracted from install.sh, reloaded the dummy job cleanly in 4s and also passes the never-loaded first-install case. deploy/README.md needed no change; docs/troubleshooting.md gains a Deployment row.
