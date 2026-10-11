---
# pkm-a7i8
title: Local copy file the host can't open hangs the request and leaks a thread
status: completed
type: bug
priority: high
created_at: 2026-10-11T12:02:05Z
updated_at: 2026-10-11T12:34:43Z
---

A `Local copy::` file the host process can't open hangs the request forever instead of failing.

## What happened

Under launchd, the prod server's `open()` on a file in Readdle's iCloud container blocks while macOS waits for a privacy (TCC, `kTCCServiceFileProviderDomain`) consent that nobody can see. `get_local_file` hands the path to Starlette's `FileResponse`, whose `anyio.open_file` runs in the sync threadpool, so:

- the request never completes, the access line is never written, and Tailscale Serve drops the iPad after about 25 s ("Loading PDF…" forever);
- every attempt holds a threadpool thread for good (15 were stuck on 2026-10-10); once the pool fills, every sync route hangs;
- `pkm local check` still says **ok**, because `_classify` only stats the file.

The consent is tied to the launchd job's binary (Homebrew's ad-hoc-signed `uv`), so it lapses on every uv upgrade. The permission identity is tracked separately; this bean makes the failure loud and contained, whatever the cause.

## Todo

- [x] `get_local_file`: probe-open the resolved file with a timeout before returning `FileResponse`; on timeout, `PermissionError` or other `OSError`, return 503 with a clear detail (e.g. "the host can't read this file"), in the same shape as the existing "not downloaded on the host" 503
- [x] Bound the damage of a probe that never returns: a timed-out thread still leaks, so cap concurrent probes (e.g. a small semaphore, failing fast with 503 when exhausted) so they can never fill the shared threadpool
- [x] `pkm local check` / `GET /api/local/check`: add an `unreadable` status that opens the file (with the same timeout and cap), reported as a problem rather than ok; update `LocalCheckPayload` status literal, the CLI output and regenerate `web/src/api/openapi.json`
- Dropped: a client-side PDF viewer timeout. The server now answers a can't-open file with a 503 within the probe timeout, and pdf.js routes that to `onLoadError`, so the viewer no longer spins on this failure.
- [x] Tests first (pytest): an open that blocks past the timeout -> 503 and the thread cap holds; `PermissionError` -> 503; check reports `unreadable`
- [x] Docs: row in `docs/troubleshooting.md` (symptom "Local copy PDF hangs on Loading PDF…, nothing in access.log"; cause "launchd process blocked opening a file in an iCloud container pending TCC consent"; owning section `files-and-assets.md`); note the new status/503 in `files-and-assets.md` and the API table in `backend.md`

## Evidence

Handover: `docs/superpowers/handoffs/2026-10-10-local-pdf-open-hang-handover.md` (gitignored). TCC.db shows `kTCCServiceFileProviderDomain` grants for `/opt/homebrew/Cellar/uv/0.12.13/bin/uv` (2026-09-21) and `/opt/homebrew/Cellar/uv/0.12.23/bin/uv` (2026-10-11 12:54); the stuck opens completed the moment the second grant was given.

## Summary of Changes

- `server/src/pkm/server/local_open.py`: `OpenProber` checks whether a file can be opened by running the open on its own daemon thread, never on anyio's threadpool, before serving it.
  - A 3 s timeout bounds how long a caller waits.
  - Callers asking about the same path while a check is already running share it and wait only for the time that check has left.
  - At most 4 checks can be in flight at once; past that, a check for a new path is refused at once (`busy`).
  - A failed thread start frees its slot.
- `/api/local/{path}`:
  - A file that can't be opened (timeout or OSError) gets a 503 "the host can't open this file", and a refused check gets a 503 "too many file opens are in flight". Both carry `Retry-After`.
  - A dataless file (SF_DATALESS, macOS's stub-less eviction) gets the existing evicted 503 plus a download request.
- `/api/local/check` gains two statuses: `unreadable` (the open check failed) and `unchecked` (the check was refused). It never opens a dataless file, so it never triggers a download.
- The PDF viewer's 503 note now covers both causes. The OpenAPI schema and types are regenerated.
- Docs:
  - `backend.md`: API rows, plus prose on why the check exists, the cap and the double open.
  - `frontend-rendering.md`, `docs/cli.md` and the pkm skill: status lists updated.
  - `docs/troubleshooting.md`: one merged row keyed by the symptoms you see now that the fix is in.
- Verified:
  - Server: pytest (2503 passed, 97.52% coverage), pyrefly and ruff all pass.
  - Web: `pnpm verify` passes, including all 78 Playwright tests.
  - `perf/check.sh`: no changes on backend or frontend.
  - An Opus whole-branch review raised 3 Important and 8 Minor findings, all fixed; its 10 mutation probes were all caught by the tests.
