---
# pkm-fy52
title: GET /api/page auto-creates daily pages on read
status: completed
type: bug
priority: normal
created_at: 2026-07-22T09:51:38Z
updated_at: 2026-07-22T11:07:40Z
---

GET /api/page/<title> (and pkm get) auto-creates an empty page row when the title parses as a daily note. Reads should not write: during the pkm-8uld investigation, three empty daily pages (July 19-21) were created just by fetching them, and the wedged client's DELETE/GET churn kept resurrecting July 11th. Auto-create belongs to the journal mount (today only) and explicit save paths, not to arbitrary page GETs. Check server routes_pages fetch path and CLI.

Design refined in docs/superpowers/specs/2026-07-22-sync-hardening-design.md (Fix C, incident bean pkm-8uld): server auto-creates ONLY today's title; web PageView renders empty editable page for missing-daily 404 (lazy create on first edit); journal day loaders map 404 to empty; replica localApi mirrors.


## Summary of Changes

Three layers now agree that a missing (non-today) daily page is an empty page, not a failure:

- **Server** (a539505): `GET /api/page/<title>` auto-creates only when `<title>` is today's daily; any other missing title 404s.
- **Local replica mirror** (4feccb0): the offline localApi GET route mirrors the same today-only auto-create rule.
- **Web views** (this change):
  - `PageView.tsx`: the direct-fetch catch and the parent-readiness path recognize a 404 whose title parses as a daily (`dateForTitle(title) !== null`) and feed the session a fabricated empty `PagePayload` via `receiveParentAuthoritative` instead of setting an error — the page renders as an empty, editable article; the first edit creates the row lazily through `CreateOp`'s `get_or_create`. A 404 for a title that is **not** a daily still shows "Could not load". PageView's own registered authoritative loader (used by `requestAuthoritative` when no explicit loader is passed, e.g. repair epochs before `EditablePage` mounts) got the same 404→`[]` guard.
  - `Journal.tsx`: both call sites that fetch a day's `/api/page/<title>` (the `sessionFor` default loader, and the inline loader in `loadMore`'s "already active" branch) now share a `fetchDayBlocks` helper that maps a 404 to `[]` instead of throwing — a day 404ing between the journal batch and the per-day refetch renders as an empty day, not a Journal-level error.
  - `useOutline.ts` (new, not in the original brief — see Deviations): the shared per-title authoritative loader that every `EditablePage` instance registers (used by PageView and Journal alike) got the same `missingDaily` guard. This was necessary, not optional: `OutlineSessionHandle`'s default-loader fallback (`requestAuthoritative(session)` with no explicit `load`, used by repair epochs and remote-ops catch-up) always picks the *last*-registered loader in the session's loader map, and `EditablePage` always mounts after — and therefore registers after — both `PageView`'s and `Journal`'s own loader registrations. Without this fix, repair-epoch or remote-ops-triggered reloads of a missing daily would still throw once any `EditablePage` for that title had mounted, regardless of the view-level fixes.

### Session-machinery resolution
Fed the fabricated payload straight through `handle.receiveParentAuthoritative(token, p)` rather than falling back to `beginAuthoritativeRead`/`receiveAuthoritative(token, [])`. Inspection of `outlineSessions.ts` showed `receiveParentAuthoritative` only reads `payload.blocks` to satisfy the manual-read token match (`finishManualRead` → `receiveAuthoritative`) and otherwise stores/publishes the payload verbatim (`publishParentPayload`) to resolve `parentWaiters` — it never validates a real server page id, so the brief's sketch worked as written with no lifecycle special-casing required.

### Test evidence
- `pnpm vitest run src/views/PageView.test.tsx src/views/Journal.test.tsx` — 35/35 passed (2 new PageView tests, 2 new Journal tests).
- `pnpm test:unit` — 95 files / 1291 tests passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis` — clean.
- `pnpm test:coverage` — thresholds pass (exit 0); PageView.tsx 88.88%/Journal.tsx 97.1%/useOutline.ts 96.1% statement coverage, no per-file threshold regressions.

### Deviations from the brief
1. Extended the fix into `useOutline.ts` (see above) — required for correctness once `EditablePage`'s loader-registration-order behavior was traced through `outlineSessions.ts`; verified failing without it via a repair-epoch test, passing with it.
2. Did not special-case `missingDaily` in the parent-readiness `.catch` (`readiness.promise.catch(...)`) as the brief's prose parenthetically suggested. Traced: `abandonManualRead`/`session.parentFailure` (which feeds that catch) is only reached via `handle.failAuthoritativeRead`, and the direct-fetch catch now routes every daily-404 to `receiveParentAuthoritative` (acceptance) before it could ever reach `failAuthoritativeRead` — so `parentFailure` can never hold a daily-404 `ApiError`. Confirmed via the passing "an expired/losing/failed parent" test suite (unchanged) that this path is unaffected.
3. `PageView.tsx`'s own registered default loader is largely superseded in practice by `EditablePage`'s (mounted internally, registers later) once a payload exists — same last-registered-wins mechanism as above. Kept the guard there anyway (defense in depth for the pre-mount window) but did not add a dedicated test forcing that exact narrow race, since `useOutline.ts`'s equivalent guard is what actually fires in every realistic scenario and is covered by the Journal repair test.

### Self-review
Read `outlineSessions.ts` in full before wiring (per the task's judgment note) rather than trusting the sketch. The Journal "activeAtResponse" test initially failed for the wrong reason (test bug, not implementation bug): pre-acquiring the session before Journal mounted made `captureActiveOutlineReads` capture it at `loadMore` start, routing through the `captured.receive` branch instead of the intended `activeAtResponse` branch — rewrote it to acquire the session mid-flight (after the journal fetch dispatched, before it resolved), matching the existing "session created mid-flight" test pattern in the same file.
