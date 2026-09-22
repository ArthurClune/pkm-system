# Troubleshooting

Failures this system has produced, keyed by what you would observe, with the
invariant the fix installed. Each row links the architecture section that owns
the mechanism; the bean in `Ref` holds the full investigation, or the test that
pins the behaviour is named instead. An em dash means neither exists.

This file is the only home for incident history. The docs under
[architecture/](architecture/overview.md) describe the system as it is today and
carry no failure stories; a fix that installs an invariant adds one row here.
Rows are written when a failure is real, never to pad a section.

## Backend (server and HTTP API)

Owner: [backend.md](architecture/backend.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A server refactor breaks the CLI/MCP client with no compile-time warning | Client-side code imports `pkm.server.ops_core`/`pkm.server.daily` directly instead of the shared `pkm/contracts/` models | [backend.md § Module map](architecture/backend.md#module-map) | test_client_contracts.py |
| Request handlers hit a database-locked error under concurrent startup | Per-connection WAL/DDL setup races an in-flight transaction; schema setup belongs in `init_db()`, never in the per-request connection | [backend.md § Database](architecture/backend.md#database) | — |
| A breadcrumb trail or backlink group truncates at 100 levels on a deeply nested page | `_fetch_ancestors`'s CTE terminates on a visited path, not a depth limit; a `depth < 100` guard truncates real trails | [backend.md § Breadcrumbs and recursive traversal](architecture/backend.md#breadcrumbs-and-recursive-traversal) | pkm-8kw2 |
| A spaces-only `[[   ]]` ref typed in the editor 500s the whole write, or crashes a rename | `get_or_create_page()` raises `BlankTitleError` and every caller must pick a recovery: `routes_ops.py` catches only `OpError`, rename only `sqlite3.IntegrityError` | [backend.md § Blank titles](architecture/backend.md#blank-titles) | test_blank_titles.py |
| Renaming a page corrupts a code span or the indent in front of a `Title::` attribute, or leaves it pointing at the old name | The rewriter must anchor an attribute span on the title rather than at column 0, and must rewrite an attribute behind a newline that `extract()` indexes as a ref | [backend.md § The write path](architecture/backend.md#the-write-path) | test_rename.py |
| The TODO page lists its own `{{[[TODO]]}}` blocks under Linked references | Backlinks and unlinked mentions skip blocks on the page itself, which needs `_backlinks`'s `b.page_id != ?` clause: the marker's `[[TODO]]` is a ref to the page it sits on | [backend.md § HTTP API reference](architecture/backend.md#http-api-reference) | pkm-r747 |
| A newly added `pkm.*` logger's INFO lines never appear in the server log | Nothing configures the root logger, so a `pkm.*` child emits only by inheriting the parent `pkm` logger's handler | [backend.md § Logging and observability](architecture/backend.md#logging-and-observability) | pkm-5g3d |

## Import, export and backup

Owner: [import-export-and-backup.md](architecture/import-export-and-backup.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A whole-database export takes minutes instead of being instant, on one large fenced code block | `refs.extract()` must stay linear; an attribute regex pairing a greedy `\s*` with an overlapping lazy class is quadratic to *fail* against a long `::`-free run | [import-export-and-backup.md § Markdown export](architecture/import-export-and-backup.md#markdown-export) | pkm-7myl |

## Frontend shell

Owner: [frontend.md](architecture/frontend.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Shift-clicking a left-nav page link opens a second browser window instead of the sidebar | react-router ignores modified clicks, so a bare `NavLink` hands the shift-click to the browser; every left-nav link goes through `NavPageLink` or `NavRouteLink` | [frontend.md § Navigation chrome](architecture/frontend.md#navigation-chrome) | pkm-10ah |
| A route shows no label in the top bar | the router, TopBar and the per-view title effect each held their own copy of the route list; all three read `routeMeta.ts` | [frontend.md § One table for route metadata](architecture/frontend.md#one-table-for-route-metadata) | pkm-77w2 |
| One edit in the journal re-renders every mounted outline | anything sharing a context identity with `pending` wakes every consumer; a consumer takes the narrowest of `SyncProvider`'s four hooks | [frontend.md § State management](architecture/frontend.md#state-management) | pkm-qfee |
| Block rows re-render with no DOM change to show for it | `EditableBlock` is memoised behind props `EditableBlockTree` holds stable; a prop whose identity changes per render defeats the memo | [frontend.md § State management](architecture/frontend.md#state-management) | pkm-qfee |
| An assistant reply shows a block citation as literal `((^uid))` text instead of a link | the model copied the `^uid` marker from tool output into the citation; `stripCaretBlockRefs` runs on assistant text before `tokenizeBlock` | [frontend.md § The assistant panel](architecture/frontend.md#the-assistant-panel) | pkm-wx86 |
| Tapping a PDF in the iOS standalone PWA replaces the whole app with the PDF, with no way back | `ExternalLinkInterceptor` ignores same-origin `target="_blank"` anchors; PDF cards open the in-app `PdfViewer` overlay | [frontend.md § The /files browser](architecture/frontend.md#the-files-browser) | pkm-5o11 |

## Editor

Owner: [frontend-editor.md](architecture/frontend-editor.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Navigating to a freshly created `[[ref]]` with Ctrl-O/Ctrl-Shift-O leaves the source block empty, its typed text gone | the unmount-only draft flush races `POST /api/pages`; `ensureRefPageThenOpen` must flush the draft explicitly before creating the page and navigating | [frontend-editor.md § Drafts and commit points](architecture/frontend-editor.md#drafts-and-commit-points) | pkm-hhbc |
| Shift-Up/Down with a text selection active at a block's edge collapses the selection and jumps focus to the neighbouring block | the boundary-arrow branch excludes Meta/Ctrl/Alt but not Shift, so a growing selection falls through to block navigation instead of escalating to a block selection | [frontend-editor.md § Rules an edit must not break](architecture/frontend-editor.md#rules-an-edit-must-not-break) | pkm-jgtn |
| A multi-block selection made while editable stays deletable after the outline switches to read-only | Backspace/Delete invokes `onDeleteBlockSelection()` unconditionally; every mutating selection branch must gate on `!readOnly` | [frontend-editor.md § Rules an edit must not break](architecture/frontend-editor.md#rules-an-edit-must-not-break) | pkm-rckh |
| After `/upload` the block stays a textarea and the image or document only appears once the cursor leaves the line | the path relies on the native file dialog blurring the textarea, which is browser behaviour; the `/upload` pick must blur the block itself before opening the picker | [frontend-editor.md § Rules an edit must not break](architecture/frontend-editor.md#rules-an-edit-must-not-break) | pkm-zrjc |
| Typing on a big page burns a fifth of a CPU core, dominated by layout, not scripting | the textarea auto-grow resets height to `auto` and re-measures on every keystroke regardless of whether the content grew or shrank, forcing layout twice per character; `textareaHeight.ts::mayHaveShrunk` gates the reset | [frontend-editor.md § Which way the editor's dependencies point](architecture/frontend-editor.md#which-way-the-editors-dependencies-point) | pkm-youp |
| Selecting a word and typing `[[` wraps it as `[[word]]` but the ref popup never opens, while typing `[[wor` does | the key-edit path and `resolve` read `selectionStart`, which sits right after the `[[` and so sees an empty query; both must read `selectionEnd` | [frontend-editor.md § Autocomplete](architecture/frontend-editor.md#autocomplete) | pkm-wxwp |
| `PageView` and a sidebar panel behave differently on the same page: one reloads on resync, one doesn't, or one loses a read | a second copy of the read lifecycle drifts from the first; both single-page surfaces must go through `outline/useOutlinePageLoad.ts` | [frontend-editor.md § Driving a session from a view](architecture/frontend-editor.md#driving-a-session-from-a-view) | — |
| A `((uid))` ref typed in a sidebar panel stays unresolved until the panel remounts | the sidebar mounts the bare `BlockRefContext.Provider`, so nothing watches for newly resolved texts; outline surfaces must mount `BlockRefProvider` | [frontend-editor.md § Driving a session from a view](architecture/frontend-editor.md#driving-a-session-from-a-view) | pkm-0one |
| Scrolling the journal issues one `GET /api/page` per day on screen | each day fetches its own linked references; they must arrive with the day in `/api/journal`'s payload | [frontend-editor.md § Journal day references](architecture/frontend-editor.md#journal-day-references) | pkm-5fak |

## Rendering

Owner: [frontend-rendering.md](architecture/frontend-rendering.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Two mermaid diagrams on one page clobber each other's rendered SVG | stock mermaid's `render()` looks its render id up in `document`, so two fallback diagrams mounting in the same commit must render with distinct real ids; only the cached copy is normalised to `MERMAID_CACHE_RENDER_ID`, and `withRenderId` puts each instance's own id back | [frontend-rendering.md § Mermaid](architecture/frontend-rendering.md#mermaid) | pkm-pekk |
| The references popover renders clipped off the right window edge, and no scrollbar appears to reach it | its fixed position applied the badge anchor verbatim; the popover must clamp its measured rect into the viewport (`popoverPosition.ts`) | [frontend.md § Popovers and menus](architecture/frontend.md#popovers-and-menus) | pkm-7iv7 |

## Styling

Owner: [styling.md](architecture/styling.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| On a phone, Tab lands on invisible controls before anything visible | the closed drawer uses `transform: translateX(-100%)` alone, which keeps its links tabbable as the page's first tab stops; it must also toggle `visibility` | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-cq32 |
| Page-title rename and the Unlinked references collapse cannot be reached from the keyboard | `onClick` sits on a non-focusable `<h1>`/`<h2>`; the label must be a real `<button>` inside the heading | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-cq32 |
| A bullet menu or references popover in the journal opens hundreds of pixels from the pointer | a `content-visibility` (or `contain: layout`) ancestor becomes the containing block for the fixed surface; both surfaces must portal to `document.body` | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-muka |
| On iPadOS Safari a PDF block's row runs hundreds of pixels past its footer, leaving blank space before the next block until a reload or tab switch | a layout-contained box has no baseline; without `contain: layout` on `.pdf-frame`, the baseline-aligned `.block-row` takes its baseline from a canvas inside the `.pdf-frame` scroller | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-vg3y |

## Sync and offline

Owner: [sync-and-offline.md](architecture/sync-and-offline.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A flapping link refetches every mounted view after each 2 s blip | `resyncSeq` was bumped after any successful reconnect, whether or not the catch-up found anything to apply | [sync-and-offline.md § Ancillary details](architecture/sync-and-offline.md#ancillary-details) | pkm-5fak |
| Every retry of the OPFS open fails instantly with the same error | the memoised-rejection trap: `forceReinitIfPreviouslyFailed` was dropped from `SAH_POOL_INSTALL_OPTIONS` | [sync-and-offline.md § When the replica cannot be opened](architecture/sync-and-offline.md#when-the-replica-cannot-be-opened) | pkm-wi25 |
| Reads work; every edit fails `SQLITE_CANTOPEN` | the pool installed at capacity 1 and the top-up to `MIN_POOL_CAPACITY` is missing or ran too late | [sync-and-offline.md § When the replica cannot be opened](architecture/sync-and-offline.md#when-the-replica-cannot-be-opened) | pkm-ndcu |
| Two replicas on one iPad stall at the same `since=`, both logged under one IP | a home-screen PWA has its own storage partition, so Safari and the PWA hold independent replicas with independent cursors and queues | [sync-and-offline.md § When the replica cannot be opened](architecture/sync-and-offline.md#when-the-replica-cannot-be-opened) | — |
| "Server rejected a change" and the outline reverts, but the server is healthy | a *local* storage failure reached `onDesync`. Retention was once a whitelist matched on error message; the blocklist on `rejected` is what makes an unrecognised storage failure retain by default | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-c9hp, pkm-s7af |
| After reconnect, durable delivery never resumes and the drain never reports `"drained"` | the drain kept calling a dead replica. Its "no repeated OPFS open" premise holds only because of the worker's latch — do not "fix" this by re-arming the DB | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-9x6u |
| Every replica write fails with a bare `disk I/O error` and nothing says the disk is full | the opfs-sahpool VFS catches `SyncAccessHandle.write()`'s `QuotaExceededError`, stores it privately and returns `SQLITE_IOERR`, so an exhausted disk is indistinguishable from any other write failure and no read-only "storage full" mode has a signal to trigger on | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-avag |
| A profile stays wedged across sessions after a rejected batch | the retained mark intent in `localStorage` clears only after a successful `markPoisoned`, which an unopenable replica can never do. The banner's "Discard rejected change" releases it | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-tu5k |
| A report of unsent edits, but it is unclear whether the recovery barrier or the network is at fault | lane ops with no durable queue look identical in both cases; the barrier case clears by lifting the barrier, the offline case only by reconnecting before the tab closes | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-bjae |
| Startup wedges: edits accepted, nothing delivered, socket up | the recovery barrier was held on an RPC that could never answer, and the lane was never drained | [sync-and-offline.md § Availability: two values, one owner](architecture/sync-and-offline.md#availability-two-values-one-owner) | pkm-bjae |
| Unsent edits vanish on reload in an online-only session | the lane is their only home. `useUnloadGuard` interrupts the reload, but an iOS standalone PWA ignores `beforeunload`, so on iPad the banner's own Reload confirm is the only warning | [sync-and-offline.md § The in-memory fallback lane](architecture/sync-and-offline.md#the-in-memory-fallback-lane) | pkm-bjae, pkm-0htf |
| "Server rejected a change (HTTP 400)" on reconnect, a `create` of a uid that already exists | a lost enqueue reply once split one batch into two ids — the worker minted the durable row's id, the lane copy got a fresh one, and the replay dedup never matched. The id is now minted main-thread and shared | [sync-and-offline.md § The in-memory fallback lane](architecture/sync-and-offline.md#the-in-memory-fallback-lane) | pkm-ybgt |
| Two tabs; one tab's `update_text` overwrote the other's with no `[[conflict]]` sibling | the op carried no `base_text_hash`, so the server took its legacy branch and plain last-write-wins | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-4ubd |
| A collapse made offline reorders recently-changed lists, then un-reorders on resync | one side stamped `updated_at` for `set_collapsed` and the other did not | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-r7k8 |
| A breadcrumb read offline differs from the same read online; descendants orphaned after an offline delete or cross-page move | a depth cap on the replica's recursive walks (both were `depth < 100`) | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-8kw2 |
| A page renamed or merged away comes back under its old title a few seconds later, with a `[[conflict]]` sibling on some block that referenced it | another device held an unsynced edit to a block the rename rewrote, and last-write-wins let its stale text win verbatim, `[[title]]` and all. The rename is now replayed over the incoming text first, so that edit applies under the new title; a block edited again after the rename still forks a `[[conflict]]` sibling, but both texts carry the new title | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-n31j, pkm-x5w0 |
| Offline for ~30 s shows "Local sync is stuck … Reset local data" instead of plain Offline | `OfflineError` (status 0, thrown when the offline gateway has no local route for a request) extends `ApiError`, so it passed the stall classifier's `instanceof ApiError` check like a real server rejection | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-gw5r |
| A deleted page keeps showing in replicas until some unrelated edit | a journal-advancing route committed without nudging; add it to `test_journal_advancing_contract.py` | [sync-and-offline.md § Post-commit nudges](architecture/sync-and-offline.md#post-commit-nudges) | pkm-getl |
| "Local sync is stuck: … UNIQUE constraint failed: pages.title" (or `sidebar_entries.title`), and the server log shows the same `changes?since=` window refetched with growing backoff | the window upserted pages before its tombstones. A merge deleted a page, a stale client re-created its title under a new id, and both facts landed in one window, so the new row collided with the local row that still held the title. Tombstones now lead and colliding titles are parked | [sync-and-offline.md § The changes feed](architecture/sync-and-offline.md#the-changes-feed) | pkm-n31j |
| "Local sync is stuck: … FOREIGN KEY constraint failed", and Reset local data churns | a changes window shipped a block whose `parent_uid` or `page_id` no window had delivered, or `reapplyPending` re-created a pending block under a row the feed removed — deferred FKs surface both only at COMMIT, past the savepoints | [sync-and-offline.md § Rebootstrap triggers](architecture/sync-and-offline.md#rebootstrap-triggers) | pkm-qvlx |
| "Local sync is stuck: SQLITE_CORRUPT_VTAB … database disk image is malformed", cleared only by a manual Reset local data | the FTS5 index disagrees with `blocks`/`pages`; FTS5 raises 267 when a delete would push its row or token totals below zero. A rebase would replay the same triggers over the same index, so corruption takes one automatic `reset` per session rather than being classified as a stall | [sync-and-offline.md § Rebootstrap triggers](architecture/sync-and-offline.md#rebootstrap-triggers) | pkm-n31j |
| A first-ever offline load with an empty op queue never bootstraps; views stay empty until a manual reload | the first-connect gate looked at pending-op count alone, so a mount-time bootstrap that failed for being offline was never retried once connectivity returned | [sync-and-offline.md § Ancillary details](architecture/sync-and-offline.md#ancillary-details) | pkm-8k2c |

## Assistant

Owner: [assistant.md](architecture/assistant.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| The assistant never calls any pkm tool; every turn is plain text | with `tools=[]`, the SDK defers MCP tool discovery behind its own ToolSearch meta-tool unless `ENABLE_TOOL_SEARCH=false` is set | [assistant.md § Harness confinement](architecture/assistant.md#harness-confinement) | pkm-wn2s |
| A tab closed mid-turn left the conversation in the registry, its harness subprocess and 0600 token file alive, and a later turn was handed that harness | the SSE layer stopped iterating instead of closing the event stream, and the response task's repeated cancellation cut short the bounded interrupt | [assistant.md § Conversation registry](architecture/assistant.md#conversation-registry) | pkm-f3mo |
| The panel sat at "thinking…" indefinitely on a dead network, with only a manual Stop ending the turn | the SDK's model request has no first-token timeout, and nothing distinguishes a stuck request from a thinking model | [assistant.md § Keepalives and the stall watchdog](architecture/assistant.md#keepalives-and-the-stall-watchdog) | pkm-e9ok |

## CLI and MCP

Owner: [cli-and-mcp.md](architecture/cli-and-mcp.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| `--section "## Notes"` returns an H3 or a plain block | a marked spec matches heading level and text together; only a bare spec (`Notes`) matches any level | [cli-and-mcp.md § Section selection](architecture/cli-and-mcp.md#section-selection) | — |
| A heading copied from `pkm todos`/`search`/`refs` output and written back with `pkm update` silently becomes plain text | those verbs' response models carry no `heading` field, so the text they print is bare (a snippet, for `search`); the round trip is `pkm get`/`get_page`/`get_block` only | [cli-and-mcp.md § Heading round trip](architecture/cli-and-mcp.md#heading-round-trip) | — |
| `pkm get -abc123` fails with an unknown-option error | argparse reads a leading-`-` uid as a flag; use `pkm get -- -abc123`, with any `-D`/`-T` flags before the `--` | [cli-and-mcp.md § Writes, uids and missing pages](architecture/cli-and-mcp.md#writes-uids-and-missing-pages) | — |
