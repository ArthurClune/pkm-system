---
# pkm-1wv1
title: Deduplicate queued and in-flight image descriptions
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:51:27Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 15).

## Context

**References:** `server/src/pkm/describe/service.py:60-79,96-122`; `server/src/pkm/describe/routes.py:23-28`

Uploads and scans enqueue SHA values without pending/in-flight deduplication. Duplicate entries after a failure can repeatedly send the same private image to the external describer, multiplying cost and rate-limit pressure.

**Direction:** Track queued/in-flight SHAs with finally cleanup and model force-retry intent explicitly.

## Tasks

- [x] Add duplicate upload/scan tests with a failing describer
- [x] Guarantee at most one ordinary in-flight attempt per asset

## Summary of Changes

`DescribeService` now tracks a `_active: set[str]` of SHAs currently
queued or mid-attempt (`server/src/pkm/describe/service.py`):

- `maybe_enqueue` and `scan` both skip a sha already in `_active` instead
  of unconditionally calling `put_nowait`, so a duplicate upload of the
  same content, or a repeat scan before the worker drains the first pass,
  no longer double-queues an asset.
- The worker's `finally` block (already there for `task_done()`) now also
  does `self._active.discard(sha)`, so the guard clears itself once an
  attempt finishes -- success, recorded failure, or an unexpected
  exception -- and never permanently blocks a sha.
- `scan(force=True)` is untouched as the intentional re-describe path: the
  `_active` check is purely a concurrency guard (only blocks a sha that
  is *currently* queued/in-flight), not a history of past failures, so a
  force-rescan still reaches a sha once its prior attempt has actually
  completed.

Tests (`server/tests/test_describe_service.py`,
`server/tests/test_describe_routes.py`): new
`BlockingDescriber` test double (`server/tests/fake_describer.py`) that
genuinely blocks mid-`describe()` call via a `threading.Event` awaited
through `asyncio.to_thread`, so tests can force real overlap between two
enqueue attempts instead of relying on a race. Added
`test_maybe_enqueue_dedupes_while_in_flight`,
`test_scan_does_not_requeue_a_sha_already_active`, and
`test_duplicate_upload_of_same_content_describes_once`; updated
`test_scan_enqueues_undescribed_and_force_retries` to drain the first
scan's attempt before force-rescanning, since that sha would otherwise
still be legitimately "active" (this is the correct new behavior, not a
loosening of the test).

Full server suite: 1058 passed, 96.33% coverage. `pyrefly check` and
`ruff check` clean. No route/param changes, so no OpenAPI/doc updates
were needed.
