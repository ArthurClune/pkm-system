---
# pkm-h7jb
title: 'E2E: pre-reload .ws-banner wait is vacuous while connected (latent flake in edit.spec)'
status: completed
type: bug
created_at: 2026-07-16T18:26:50Z
updated_at: 2026-07-16T18:26:50Z
---

Discovered during pkm-7q14: OfflineIndicator only renders the 'Syncing - N pending' banner when syncingAfterReconnect is set (after a disconnect). In a normally-connected session pending>0 shows no banner, so 'await expect(.ws-banner).toHaveCount(0)' before page.reload() (e2e/edit.spec.ts:57, comment claims it waits for queue drain) never waits for the last batch's HTTP delivery and reload can race it. undo.spec.ts was hit by exactly this and now polls the server via /api/page (waitForServerText helper, commit 4e2f5ee) - reuse that pattern in edit.spec, and consider whether OfflineIndicator should show the syncing banner whenever pending>0. Also consider a product-level question: an in-flight batch lost to reload was not replayed from the offline queue within the e2e wait window - worth verifying queue persistence semantics for the online in-flight case.

## Checklist

- [x] Extract waitForServerText into a shared e2e helper (server-state.ts)
- [x] Replace the vacuous pre-reload .ws-banner wait in edit.spec.ts with waitForServerText
- [x] Point undo.spec.ts at the shared helper
- [x] Audit other specs for the same vacuous pre-reload pattern (offline.spec.ts:116 is fine — post-reconnect, syncingAfterReconnect is set and server state is checked via API before reload; undo.spec.ts:74 is vacuous but nothing races it)
- [x] Consider: should OfflineIndicator show the syncing banner whenever pending>0?
- [x] Consider: queue persistence semantics for an online in-flight batch lost to reload
- [x] `pnpm verify` green (typecheck, lint, fcis, unit coverage, build, 9/9 e2e)

## Product-question assessments

**Banner whenever pending>0: no.** While connected, every draft flush briefly
has pending>0, so the banner would flash on nearly every edit — noisy for no
user value. The quiet-while-connected behaviour is deliberate (see
OfflineIndicator.tsx header). The real lesson is that tests must never use
the banner as a delivery proxy; poll the server (e2e/server-state.ts).

**Queue persistence for the online in-flight case: semantics are sound.**
replica.enqueue persists the batch durably before any POST; the row is only
deleted after the POST succeeds (opQueue.ts runDrain), and SyncProvider reads
pendingCount() at mount and treats a first connect with a non-empty durable
queue as a reconnect, draining leftovers (SyncProvider.tsx ~400-459). The
observed non-replay during pkm-7q14 is explained by the earlier window: an op
the UI flushed but the replica worker had not yet accepted when reload killed
the page was never durable at all. That window is inherent to any
local-first editor and is invisible to the user in practice (sub-ms worker
round-trip); no product change recommended.

## Summary of Changes

- New `web/e2e/server-state.ts`: shared `waitForServerText` helper (moved
  from undo.spec.ts) that polls `/api/page/<title>` until a block contains
  the given text — the deterministic replacement for pre-reload banner waits.
- `web/e2e/edit.spec.ts`: the vacuous pre-reload `.ws-banner` toHaveCount(0)
  wait is now `waitForServerText(page, pageTitle, "second block [[E2E
  Target]]")`, so reload can no longer race the last batch's HTTP delivery.
- `web/e2e/undo.spec.ts`: imports the shared helper instead of its private
  copy.
- Audited remaining specs: offline.spec.ts's pre-reload banner wait is
  legitimate (post-reconnect, banner actually renders, plus a direct API
  assertion); no other spec reloads behind a vacuous wait.
- No product changes: banner-on-pending rejected (would flash on every
  edit), queue persistence verified sound (see assessments above).
