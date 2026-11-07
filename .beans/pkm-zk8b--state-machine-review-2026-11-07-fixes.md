---
# pkm-zk8b
title: 'State-machine review (2026-11-07): fixes'
status: todo
type: epic
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3.

Six reviewers inventoried the explicit and implicit state machines in each
area (web sync, replica, outline editor, web UI, server app, server library);
a second, adversarial pass re-traced every finding. The children are the
findings that held and are worth fixing. Findings judged not worth fixing,
with reasons, are listed below so they are not re-proposed without new
evidence.

Rule for every child that introduces or changes a state machine: full
property testing (model from the docs, an event alphabet that reaches the
interleaving that found the bug, reach rates read, teeth shown,
`proptest/check.sh` before merge). Each such child carries its own sketch.

## Recurring shapes the review found
- One flag with several owners (the queue barrier; two "draft dirty" truths;
  "is there a database" answered in three places).
- An unnamed phase with no handler for events arriving in it (assistant
  "server done, harness not"; replica "queue unreadable"; sync "started once
  and failed").
- State used after an await without re-checking it.
- Operational procedures outside the machine (restore, importer) that
  bypass the generation token, the WAL or the write lock.

## Not fixed, and why

Re-propose only with new evidence (a sighting, or a change that makes the
trigger reachable).

| Area | Finding | Why not |
|---|---|---|
| server | Upload and delete of the same sha race, leaving a row with no file | Needs identical bytes uploaded inside the delete's lock hold (ms); one broken image, healed by re-upload; the fix collides with the lock-on-loop trade in pkm-8w77 |
| server | 30-day rewrite/deletion retention is unenforced | Needs an unsent queue older than 30 days that names a page deleted or renamed meanwhile; the result is a visible stray page, nothing lost |
| server | Lock waits block the event loop up to 5 s | Same trade Arthur deferred in pkm-8w77 |
| server | A renamed-away title is not stale for a top-level create/move | Is pkm-7v8l (deferred); pinned by the sync property |
| server | Login double-submit gets 401 under scrypt slot contention | Needs 4+ other sources hashing at once; tailnet-only, one user |
| server | A hub-dropped WebSocket can linger | The client replaces the socket after 30 s hidden; the close frame usually flushes |
| server | `expect` accepts one uid twice | No producer sends it, and it fails closed (412, nothing written) |
| server lib | Backup prunes before verifying; stale git index.lock; leftover .tmp | The sqlite snapshot and iCloud copy are unaffected; the lock needs a kill during a sub-second git step |
| server lib | `upload_and_link` compensates with strip-mode delete | The cross-client strip cannot happen for one user; the lost-ack case ends consistent |
| server lib | `POST .../confirm` acks an unknown confirm id | Cosmetic `...` on a late Allow after teardown |
| server lib | Mermaid migration plans outside its write transaction | One-off script, already run |
| server lib | A CLI/MCP write with a lost ack reads as "server not running"; a retry duplicates | Needs a reply slower than the 30 s timeout; a duplicate block is visible and easy to delete |
| server lib | Harness credential files survive a hard crash | No added exposure: the same user can read config.json, which holds the secret |
| sync | Frozen-socket resume waits on a close event a dead link may delay | Unverified real-Safari timing; the fix shape (detach, report offline, reconnect directly) is ready if stale-after-resume is ever seen |
| sync | One problem slot drops outcomes the user acts on | Splitting the slot costs more than the rare cosmetic loss; the poison-Retry case is in pkm-o4qp |
| sync | A closed socket handle still reports status | StrictMode dev replay only |
| replica | `inTxn` drifts when ROLLBACK fails | Refuted: SQLite's ROLLBACK always returns the connection to autocommit |
| replica | Recovery lease held in two places | Every access is token-keyed; correct |
| replica | Rows a recovery snapshot names as applied are not returned | Unreachable: runRecovery's snapshot names no pending ids |
| replica | The shim's `POST /api/pages` commits twice | The stranded-page sweep removes the leftover |
| outline | Queued undo for an unmounted page decides "no session" before its read | Folded into pkm-go73 (same chain and slow-read window; deferred) |
| outline | Large-delete confirm doesn't re-check readOnly or the run after the prompt | Needs a concurrent insert during the modal; undo restores |
| outline | Authoritative reads can starve under continuous remote typing | Converges at the first pause; bounding it needs adopt-and-rebase machinery |
| outline | Focus-guard and retained-stale-tree design notes | No reachable route / no behaviour impact |
| outline | IME preedit saved every 500 ms during a long composition | Harmless; the next save overwrites it |
| web UI | A second `confirm()` orphans the first promise | Folded into pkm-ysp6 |
| web UI | A stray error after Stop when the confirm POST fails; the default model lands after the first create and the picker stays locked after a re-create | Folded into pkm-62jb (the turn machine closes both) |
| web UI | Current Work replaced by an error when a resync fails | Network failures fall back to the replica shim, so it needs a server 5xx; navigating back reloads |
| web UI | Late navigation after an await (search create, ref open, rename) | The destination is one the user asked for; windows of one local POST |
| web UI | SidebarNav's mount GET can overwrite a mutation's list | Needs an add, a typed title and a submit before a local GET returns |
| web UI | A failed block-ref fetch is terminal for the provider's lifetime | Offline is served by the shim; ref freshness belongs to pkm-1w6u |
| web UI | AssetImage "failed" is terminal and says offline; no cross-tab theme sync | Cosmetic |

Make-explicit refactors declined (the targeted fixes in the children close
every reachable bad state found): folding `usable` into ReplicaState as a
refactor; an editing-vs-selecting mode union and a pending-draft union in
the outline (it would close pkm-lh8r and pkm-2wiw structurally, but touches
every key handler in the editor; their targeted fixes are a few lines);
a Files load reducer (pkm-iq2r's generation guard is as small).
Accepted ones live in their children, each with full property testing:
the barrier owner set (pkm-o4qp), the assistant turn phase on the server
(pkm-74vc), the replica "queue unreadable" outcome (pkm-2zbs), one owner
for "draft dirty" (pkm-eydv), the assistant conversation and turn machine
in the web panel (pkm-62jb), the Journal paging reducer (pkm-gks1).
