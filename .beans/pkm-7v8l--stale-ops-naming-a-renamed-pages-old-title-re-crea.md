---
# pkm-7v8l
title: Stale ops naming a renamed page's old title re-create it
status: todo
type: bug
priority: deferred
created_at: 2026-10-14T09:07:51Z
updated_at: 2026-10-14T17:12:10Z
---

Found in the pkm-ynze design review. Ops name pages by title. A device offline across a rename X -> Y still sends top-level create/move/create_page with page_title X, and the server re-creates X (block_rewrites retitle replay rewrites block text, not an op's page_title). With a later delete of Y, the stale op re-creates X even though pkm-ynze parks stale ops on deleted titles.

Out of scope for pkm-ynze (rename semantics). Needs its own design: e.g. resolve a stale page_title through recorded retitles within the retention window.

## Deferred (2026-10-14)

Arthur deferred this: it's a single-user system, so the user knows they renamed the page. Notes from the discussion:

- Viewing doesn't trigger it. Opening the old page offline and leaving it queues no ops (the unmount flush sends only typed text), so the page stays renamed/deleted after reconnect.
- Writing does trigger it, if the write is an op that names the page by title: a new top-level block (including typed text flushed on navigate/background), "Click to start writing…" on an empty page, or Ctrl-O on a [[X]] ref (POST /api/pages). Edits to existing blocks target the uid and are unaffected.
- The result is a ghost page X holding the new block. Nothing is lost.
- If it is picked up later, the proposed answers to the handover's design questions: resolve a merge to its target; follow a date-shaped rename into the daily note; 30-day retention like page_deletions; write to the resolved page silently.
