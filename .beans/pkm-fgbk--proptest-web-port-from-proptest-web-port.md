---
# pkm-fgbk
title: proptest web port from PROPTEST_PORT
status: completed
type: feature
priority: normal
created_at: 2026-11-12T17:21:46Z
updated_at: 2026-11-12T17:26:01Z
---

proptest/check.sh web hard-codes port 8978, so two sessions' property runs clash (the second refuses: 'port 8978 is already in use'). Let the environment pick the port, keep 8978 as default, and name the sync server's log files by port so parallel runs don't overwrite each other's logs.

## Summary of Changes

Symptom: a second session's `proptest/check.sh web` printed "web: port 8978 is already in use; refusing to touch it." Cause: `server/tooling/proptest/run.py` hard-coded `WEB_PORT = 8978`. Now `web_port()` in `run.py` reads `PROPTEST_PORT` (default 8978, refuses 8974 and non-ports). It passes the port to the sync server, which already read `PROPTEST_PORT`, and to vitest through `web_env`. The sync server's `.log`/`.out` files in the temp dir are named by port, so parallel runs keep separate logs. AGENTS.md's port table reserves 8990–8999 for parallel runs.
