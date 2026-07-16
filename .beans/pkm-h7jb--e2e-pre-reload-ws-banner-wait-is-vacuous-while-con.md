---
# pkm-h7jb
title: 'E2E: pre-reload .ws-banner wait is vacuous while connected (latent flake in edit.spec)'
status: todo
type: bug
created_at: 2026-07-16T18:26:50Z
updated_at: 2026-07-16T18:26:50Z
---

Discovered during pkm-7q14: OfflineIndicator only renders the 'Syncing - N pending' banner when syncingAfterReconnect is set (after a disconnect). In a normally-connected session pending>0 shows no banner, so 'await expect(.ws-banner).toHaveCount(0)' before page.reload() (e2e/edit.spec.ts:57, comment claims it waits for queue drain) never waits for the last batch's HTTP delivery and reload can race it. undo.spec.ts was hit by exactly this and now polls the server via /api/page (waitForServerText helper, commit 4e2f5ee) - reuse that pattern in edit.spec, and consider whether OfflineIndicator should show the syncing banner whenever pending>0. Also consider a product-level question: an in-flight batch lost to reload was not replayed from the offline queue within the e2e wait window - worth verifying queue persistence semantics for the online in-flight case.
