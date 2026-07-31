---
# pkm-ndcu
title: 'E2E suite is load-sensitive: edit.spec.ts and paste.spec.ts flake on a busy machine'
status: in-progress
type: bug
priority: normal
created_at: 2026-07-30T07:57:36Z
updated_at: 2026-07-31T08:29:44Z
---

`pnpm verify`'s Playwright suite is not reliably green on a loaded machine. Observed repeatedly during pkm-0wg9 (2026-07-29), always as an outline-editor timeout, at several different line numbers:

- `web/e2e/edit.spec.ts` — failures seen at `:124`, `:220` and `:308` across runs
- `web/e2e/paste.spec.ts:53` — first sighting, new to the flake list

Every failure passed on a rerun with **zero code changes** in between.

This is confirmed pre-existing, not caused by pkm-0wg9. It was established by baseline-measurement rather than by assumption: `67e3303`'s `web/src` was checked out in place, rebuilt, and E2E run twice — 1 pass, 1 failure at `edit.spec.ts:124`. A reviewer independently confirmed via `git diff --stat` that `server/`, `web/e2e/` and `playwright.config.ts` were byte-identical across the whole branch.

Prior related history: `edit.spec.ts:308` load-sensitivity was already noted in the 2026-07-27 batch, and a "Server rejected a change. Active outlines repaired." banner (seen during one of these failures) traced in pkm-c9hp to OPFS SAH-pool contention on reload rather than any server-side rejection — so storage contention under load is the leading hypothesis, not sync logic.

Worth fixing because it erodes trust in the gate: a real regression in these specs would currently be dismissed as "the usual flake".

- [ ] Reproduce deliberately under load (parallel workers, or an artificial CPU load)
- [ ] Confirm or rule out OPFS SAH-pool contention as the mechanism
- [ ] Fix the root cause, or make the affected waits robust rather than time-based
- [ ] Run the suite repeatedly under load to show it holds
