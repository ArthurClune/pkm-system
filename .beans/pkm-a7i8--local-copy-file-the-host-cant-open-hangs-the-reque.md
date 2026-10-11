---
# pkm-a7i8
title: Local copy file the host can't open hangs the request and leaks a thread
status: todo
type: bug
priority: high
created_at: 2026-10-11T12:02:05Z
updated_at: 2026-10-11T12:02:05Z
---

A `Local copy::` file the host process can't open hangs the request forever instead of failing.

## What happened

Under launchd, the prod server's `open()` on a file in Readdle's iCloud container blocks while macOS waits for a privacy (TCC, `kTCCServiceFileProviderDomain`) consent that nobody can see. `get_local_file` hands the path to Starlette's `FileResponse`, whose `anyio.open_file` runs in the sync threadpool, so:

- the request never completes, the access line is never written, and Tailscale Serve drops the iPad after about 25 s ("Loading PDF…" forever);
- every attempt holds a threadpool thread for good (15 were stuck on 2026-10-10); once the pool fills, every sync route hangs;
- `pkm local check` still says **ok**, because `_classify` only stats the file.

The consent is tied to the launchd job's binary (Homebrew's ad-hoc-signed `uv`), so it lapses on every uv upgrade. The permission identity is tracked separately; this bean makes the failure loud and contained, whatever the cause.

## Todo

- [ ] `get_local_file`: probe-open the resolved file with a timeout before returning `FileResponse`; on timeout, `PermissionError` or other `OSError`, return 503 with a clear detail (e.g. "the host can't read this file"), in the same shape as the existing "not downloaded on the host" 503
- [ ] Bound the damage of a probe that never returns: a timed-out thread still leaks, so cap concurrent probes (e.g. a small semaphore, failing fast with 503 when exhausted) so they can never fill the shared threadpool
- [ ] `pkm local check` / `GET /api/local/check`: add an `unreadable` status that opens the file (with the same timeout and cap), reported as a problem rather than ok; update `LocalCheckPayload` status literal, the CLI output and regenerate `web/src/api/openapi.json`
- [ ] Optional: the web PDF viewer times out and shows the fallback link instead of spinning forever
- [ ] Tests first (pytest): an open that blocks past the timeout -> 503 and the thread cap holds; `PermissionError` -> 503; check reports `unreadable`
- [ ] Docs: row in `docs/troubleshooting.md` (symptom "Local copy PDF hangs on Loading PDF…, nothing in access.log"; cause "launchd process blocked opening a file in an iCloud container pending TCC consent"; owning section `files-and-assets.md`); note the new status/503 in `files-and-assets.md` and the API table in `backend.md`

## Evidence

Handover: `docs/superpowers/handoffs/2026-10-10-local-pdf-open-hang-handover.md` (gitignored). TCC.db shows `kTCCServiceFileProviderDomain` grants for `/opt/homebrew/Cellar/uv/0.12.13/bin/uv` (2026-09-21) and `/opt/homebrew/Cellar/uv/0.12.23/bin/uv` (2026-10-11 12:54); the stuck opens completed the moment the second grant was given.
