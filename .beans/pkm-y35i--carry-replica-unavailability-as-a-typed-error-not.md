---
# pkm-y35i
title: Carry replica unavailability as a typed error, not a message match
status: completed
type: task
priority: normal
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T14:29:55Z
parent: pkm-q2jj
blocking:
    - pkm-s7af
---

Add ReplicaUnavailableError (extends ReplicaError, so existing instanceof checks keep working) and an `unavailable` boolean on the wire error shape beside `quota`, following the precedent documented at rpc.ts:4. No consumers in this step. Note: only `unusable` crosses the wire (the worker reporting its own failed open); `unreachable` is generated client-side by the RPC layer, so the two levels are combined on the main thread, never in the wire shape. Also ensure isStallShaped does NOT count an unavailable error, or a session reports stalled on top of no-replica and computeEditability can flip it read-only.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md

## Summary of Changes

Created `web/src/replica/errors.ts` (Functional Core): `ReplicaErrorFlags`,
`ReplicaError` (now `(message, flags?)` instead of `(message, quota: boolean)`),
`ReplicaUnavailableError extends ReplicaError`, `RpcLifecycleKind`/`RpcLifecycleError`
(moved verbatim from `rpc.ts`), `ReplicaAvailability`, `availabilityOf`, `isSessionFatal`.

`rpc.ts` now imports the taxonomy instead of defining it, re-exporting for
transitional compatibility (to be deleted in Task 8 once no importer needs
`../replica/rpc` for these names). Wire shape gained `rejected` and `unavailable`
booleans alongside `quota`; `serveRpc` reads `rejected`/`unavailable` off the
thrown error, the client reconstructs `ReplicaUnavailableError` when `unavailable`
is set. `LocalOpError` (localOps.ts) now carries `readonly rejected = true` so
title-syntax violations travel as a flag, not a message to match.

`replicaSync.ts`'s `isStallShaped` now excludes any error `availabilityOf` matches
(unusable or unreachable) before checking `ApiError`/`ReplicaError`/`PullStarvedError`,
so a session that has already reported `no-replica` never also stalls.

Switched remaining importers (`opQueue.ts`, `opQueue.replica.test.ts`,
`replicaSync.test.ts`, `rpc.test.ts`) to import `ReplicaError` from `./errors`/
`../replica/errors` directly, and fixed the three `new ReplicaError(msg, boolean)`
call sites to the flags-object form.

No consumer behaviour changes except `isStallShaped`. Verification: `pnpm typecheck`
clean, `pnpm test:unit` 1985/1985 passed (0 jsdom warnings), `pnpm verify` full run
green (coverage 97.7/93.11/95.18/97.7, all above the 95/91/89/95 thresholds;
`errors.ts` itself 100/100/100/100; 51/51 e2e passed).
