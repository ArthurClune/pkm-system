---
# pkm-d7e1
title: A changes window that fails to apply for any non-FK reason refetches forever
status: todo
type: bug
created_at: 2026-09-03T09:22:53Z
updated_at: 2026-09-03T09:22:53Z
---

Found auditing pkm-n31j. applyChanges maps three failure classes to needs-bootstrap (deferred FK at COMMIT, a still-parked title holder, corruption via replicaSync). Every other deterministic failure of applyWindow -- a NOT NULL or CHECK violation from a malformed feed, a bug in upsertBlock or reconcilePage -- rolls the window back, leaves the cursor in place, and the stall backoff refetches the identical window until the user presses Reset local data. That is the wedge shape both pkm-qvlx and pkm-n31j had; each fix has added one class to the whitelist. Proposal to decide: after N consecutive failures of the SAME cursor with the same error text, treat the window as unappliable and rebootstrap (rebase), keeping the stall banner only for failures a snapshot also cannot clear. Cost: hides a feed bug behind a resync (the reason applyFkHazards.test pins that non-FK failures throw); mitigated by posting the failure through /api/client/diagnostics (pkm-1mx9) before rebootstrapping.
