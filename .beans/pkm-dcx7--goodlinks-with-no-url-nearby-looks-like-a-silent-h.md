---
# pkm-dcx7
title: /goodlinks 'No URL nearby' notice is easy to miss
status: todo
type: bug
priority: deferred
created_at: 2026-10-13T19:03:36Z
updated_at: 2026-10-13T19:04:43Z
---

## Symptom
On `Paper/Can LLMs Be Computers?` (2026-10-13) Arthur ran `/goodlinks` in an empty block directly after `Date:: Mar 2026`; the page's `URL::` block was two siblings up. Nothing visibly happened; it read as a hang. The server log shows no `/api/goodlinks/resolve` call at that time, so the command stopped in the client.

## What the code does
- `outline/goodlinks.ts` `goodlinksCandidates` looks for a URL in the block, its parent, then its previous sibling only. Here none had one.
- `useOutline.ts` `onGoodlinks` then sets the notice `"No URL nearby"` and returns.
- `EditablePage.tsx` renders that notice as a `role="status"` paragraph at the top of the outline container, not near the block. Arthur later confirmed the notice does show; the issue is only that it is easy to miss. Deferred 2026-10-13.

## Decided
- Keep the candidate rule as it is. Searching the page for any `URL::` block could easily pick the wrong one.
- The fix is a clear, noticeable error, e.g. "Couldn't find a URL" shown where the user is looking, instead of what reads as a silent hang.

## Todo
- [ ] Reproduce: the block after a non-URL sibling, `/goodlinks`, see what (if anything) shows and where
- [ ] Make the no-URL failure visible near the block (or as an alert the user can't miss), with a clear message
- [ ] Unit test for the no-candidate path; e2e if the fix is in placement
