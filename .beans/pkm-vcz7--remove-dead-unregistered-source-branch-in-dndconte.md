---
# pkm-vcz7
title: Remove dead unregistered-source branch in DndContext.drop(); fix stale refetch doc comment
status: completed
type: task
priority: low
created_at: 2026-07-10T12:12:44Z
updated_at: 2026-07-10T12:35:43Z
---

Follow-up from pkm-auvy review. Item 1 of pkm-auvy (fallback panels fully excluded from DnD) made the unregistered-source branch in DndContext.drop() (web/src/dnd/DndContext.tsx ~91: 'if (dst && !node) dst.refetch()') production-unreachable: startDrag's only caller is the non-fallback path, and every non-fallback instance registers via registerOutline, so src can no longer be undefined at a real drop. Only its unit test exercises it. Also OutlineDndApi.refetch's doc comment (DndContext.tsx:17-19) still describes 'dragged from a panel of an unopened page', stale post-exclusion. Removal may cascade into useOutline — assess scope before deleting.

## Checklist
- [x] Remove the unreachable branch and its unit test (or document why it must stay)
- [x] Update the OutlineDndApi.refetch doc comment to current semantics
- [x] pnpm test + typecheck clean

Also fold in (from final-review triage): server/tests/e2e_serve.py:69-78 — the signal-handler comment says uvicorn's re-raise makes the exit status reflect the signal, but the handler calls sys.exit(0); behavior is fine, comment is stale. Tighten the comment (or exit 128+signum) while touching doc-comment accuracy.

- [x] Fix e2e_serve.py signal-handler comment/exit-semantics mismatch

## Summary of Changes

- Confirmed the claim: `EditablePage.tsx` only wires `dnd.startDrag` inside the
  live (non-`activeElsewhere`) render branch, and that same branch is the only
  place `dnd.registerOutline` is called for that title — so any drag that can
  start already has its source outline registered. The `if (dst && !node)
  dst.refetch()` branch in `DndContext.tsx`'s cross-page `drop()` can no
  longer fire from real UI interaction.
- Removed that branch from `web/src/dnd/DndContext.tsx`.
- Assessed cascade into `useOutline`: `OutlineDndApi.refetch` had exactly one
  caller (the removed branch), so it's now fully dead as an `OutlineDndApi`
  member. Removed `refetch` from the `OutlineDndApi` interface and from the
  `dnd` object returned by `useOutline` (dropped it from the `useMemo` deps
  too). The underlying `refetch` callback in `useOutline.ts` stays — it's
  still used directly for the remote-websocket-batch "we're the target of a
  cross-page move" case — and its doc comment was updated to drop the
  now-false "used as the DnD refetch fallback" claim.
- Removed the interface's stale `refetch()` doc comment along with the
  member itself (no dangling description to fix).
- Deleted the two tests that only existed to exercise the dead branch:
  `DndContext.test.tsx`'s "cross-page drop with unregistered source
  refetches the registered target", and `SidebarPanel.test.tsx`'s "panel
  refetches after a drop that touches its page" (which called `dnd().drop()`
  directly with a synthetic unregistered source page title — the same
  now-impossible scenario, just through a different harness). Removed the
  now-dangling `refetch` references from the remaining
  "cross-page drop with unregistered target" test and from the `fakeOutline`
  test helper.
- `server/tests/e2e_serve.py`: reworded the signal-handler comment so it no
  longer implies the process's final exit status reflects the caught signal
  — our handler installs itself as the "restored" handler uvicorn re-raises
  through, then cleans up and calls `sys.exit(0)` itself, so the exit code is
  always 0, not signal-derived. Kept the `sys.exit(0)` behavior (nothing in
  the Playwright harness inspects this process's exit code; `global-teardown.ts`
  scans the server log file instead), per the bean's stated preference.
