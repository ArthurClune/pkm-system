---
# pkm-ub5s
title: Deferred minors from the medium-priority frontend reviews
status: completed
type: task
priority: low
created_at: 2026-08-18T18:58:34Z
updated_at: 2026-08-18T20:04:25Z
parent: pkm-wvvu
---

Review-deferred minor findings from pkm-3lqg / pkm-nqve / pkm-d5re / pkm-2i6a / pkm-jk21 / pkm-nvxh (task reviews under the epic's 2026-08-17 sources; the final whole-branch review triaged these as follow-up material — none block anything).

## Checklist

Correctness-adjacent polish:
- [x] tree.test.ts equivalence table: add the missing set_view_type no-op variant (a block whose view_type already matches the op) — the one untested no-op branch at tree.ts:211
- [x] docs/architecture/frontend.md change-signal paragraph overstates identity: a no-op local-ops transition still returns a new state object (it records the write ticket); only revision is unmoved, and revision is the publish gate. Add the qualifier.
- [x] BacklinksSection.tsx:95 Infinity sentinel is safe only while refresh's first nextLimit call is unconditional — add the comment saying so
- [x] BacklinksSection.tsx:24 single `loading` flag is shared by loadMore and loadAll; with both in flight the first settle re-enables buttons early (cosmetic — walks are idempotent). Comment or per-caller flag.
- [x] replicaSync.ts flushLease: make the "blocking" policy an explicit branch with a `const exhaustive: never` check (house style per queueState.ts:120) instead of untagged fall-through
- [x] replicaSync.ts "blocking" flush policy discards the original flush error — a transport failure and a server rejection are indistinguishable behind one "reset blocked" message; preserve/attach the cause
- [x] useOutline refetch: add a direct test pinning "404 on the cross-page-move catch-up read leaves a daily empty rather than rejecting" (the one judgement call in pkm-jk21's diff)

Test hygiene:
- [x] tooling/lintConfig.test.ts needs an explicit timeout — its ESLint spawn takes ~2s under coverage against the 5s default and flaked repeatedly during parallel verify runs

If Popover.tsx's remeasure prop is ever touched: replace the comment-only fixed-length contract with a shallow-compare against a ref inside the effect (length-agnostic, and the eslint-disable goes away).

## Summary of Changes

- `web/src/outline/tree.test.ts`: added a standalone `set_view_type to the
  view already there` test. `SetViewTypeOp.view_type` on the wire is
  `"numbered" | "document"` only (no `null`), so unlike the other ops'
  no-op variants this couldn't reuse the shared `tree()` fixture (whose
  blocks all default to `view_type: null`) inside the generic `[name, op]`
  cases loop — it needed its own before-tree with block `a` already at
  `"numbered"`.
- `docs/architecture/frontend.md`: qualified the change-signal paragraph —
  a no-op *local* batch still returns a new state object (it records the
  write ticket) even though `revision` itself is unmoved; only *remote*
  batches return the identical object on a no-op. Verified against
  `outlineState.ts`'s `local-ops`/`remote-ops` cases and `withBlocks`.
  Ran the `architecture-docs` doc checker: links/beans/names all clean, no
  new 40+-word sentence introduced.
- `web/src/components/BacklinksSection.tsx`: added the two requested
  comments (Infinity-sentinel precondition on `refresh`; shared `loading`
  flag caveat on `loadMore`/`loadAll`). Comment-only, no behaviour change,
  so no new test.
- `web/src/sync/replicaSync.ts`: `flushLease`'s "blocking" branch is now
  explicit with a `const exhaustive: never` check matching
  `queueState.ts:120`'s house style; `ResetBlockedError` now takes an
  optional `{ cause }` and the blocking branch attaches the original flush
  failure as `cause` instead of discarding it. Extended the existing
  `resetLocalData without discardPending surfaces a blocked reset when
  flush fails` test in `replicaSync.test.ts` to assert `cause` is the
  original `Error("flush offline")`.
- `web/src/outline/useOutline.reconciliation.test.tsx`: added a test
  pinning that a cross-page-move catch-up read landing on a daily page
  title, when it 404s, adopts an empty page via `substituteMissingDaily`
  rather than being silently swallowed by `refetch`'s
  `.catch(() => undefined)` (which would otherwise leave stale content
  behind). Traced the path: `outlineSessions.applyRemote`'s
  `needsAuthoritative` check (a `move` op naming this page for an
  unseen uid) -> `useOutline`'s `refetch` -> `loadOutlineBlocks` with
  `substituteMissingDaily` -> `emptyPagePayload`.
- `web/tooling/lintConfig.test.ts`: gave both ESLint-spawning tests an
  explicit 20s timeout.

No items deferred beyond the bean's own explicit "if Popover.tsx is ever
touched" carve-out, which was left untouched as instructed.

Verification: `cd web && CI=true pnpm verify` (typecheck, lint,
`check:fcis`, coverage, build, Playwright e2e) — 142 test files / 2281
unit tests passed, e2e 54 passed, exit code 0. No coverage threshold
failures.
