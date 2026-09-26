# Troubleshooting

Failures this system has produced, keyed by what you would observe, with the
invariant the fix installed. Each row links the architecture section that owns
the mechanism. `Ref` names the bean with the full investigation, or the test
that pins the behaviour, or an em dash if neither exists.

Incident history lives only here. The docs under
[architecture/](architecture/overview.md) describe the system as it is and
carry no failure stories. A fix that installs an invariant adds one row here,
and only for a failure that happened.

## Backend (server and HTTP API)

Owner: [backend.md](architecture/backend.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A server refactor breaks the CLI/MCP client with no compile-time warning | Client code imports `pkm.server.ops_core` or `pkm.server.daily` directly; it must use the shared `pkm/contracts/` models | [backend.md § Module map](architecture/backend.md#module-map) | test_client_contracts.py |
| Request handlers hit a database-locked error under concurrent startup | Per-connection WAL/DDL setup races an in-flight transaction. Schema setup belongs in `init_db()`, never in the per-request connection | [backend.md § Database](architecture/backend.md#database) | — |
| A breadcrumb trail or backlink group truncates at 100 levels on a deeply nested page | `_fetch_ancestors`'s CTE stops on a visited path. A `depth < 100` guard truncates real trails | [backend.md § Breadcrumbs and recursive traversal](architecture/backend.md#breadcrumbs-and-recursive-traversal) | pkm-8kw2 |
| A spaces-only `[[   ]]` ref typed in the editor 500s the whole write, or crashes a rename | `get_or_create_page()` raises `BlankTitleError` and each caller must handle it. `routes_ops.py` caught only `OpError`, and rename only `sqlite3.IntegrityError` | [backend.md § Blank titles](architecture/backend.md#blank-titles) | test_blank_titles.py |
| Renaming a page corrupts a code span or the indent before a `Title::` attribute, or leaves it pointing at the old name | The rewriter must anchor an attribute span on the title, not at column 0. It must also rewrite an attribute after a newline, which `extract()` indexes as a ref | [backend.md § The write path](architecture/backend.md#the-write-path) | test_rename.py |
| The TODO page lists its own `{{[[TODO]]}}` blocks under Linked references | The marker's `[[TODO]]` is a ref to the page it sits on. Backlinks and unlinked mentions skip blocks on the page itself via `_backlinks`'s `b.page_id != ?` clause | [backend.md § HTTP API reference](architecture/backend.md#http-api-reference) | pkm-r747 |
| A newly added `pkm.*` logger's INFO lines never appear in the server log | Nothing configures the root logger. A `pkm.*` child emits only through the parent `pkm` logger's handler | [backend.md § Logging and observability](architecture/backend.md#logging-and-observability) | pkm-5g3d |

## Import, export and backup

Owner: [import-export-and-backup.md](architecture/import-export-and-backup.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A whole-database export takes minutes on one large fenced code block | `refs.extract()` must stay linear. An attribute regex pairing a greedy `\s*` with an overlapping lazy class is quadratic to *fail* against a long `::`-free run | [import-export-and-backup.md § Markdown export](architecture/import-export-and-backup.md#markdown-export) | pkm-7myl |

## Frontend shell

Owner: [frontend.md](architecture/frontend.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Shift-clicking a left-nav page link opens a second browser window instead of the sidebar | react-router ignores modified clicks, so a bare `NavLink` passes the shift-click to the browser. Every left-nav link goes through `NavPageLink` or `NavRouteLink` | [frontend.md § Navigation chrome](architecture/frontend.md#navigation-chrome) | pkm-10ah |
| A route shows no label in the top bar | The router, TopBar and the per-view title effect each kept their own route list. All three read `routeMeta.ts` | [frontend.md § One table for route metadata](architecture/frontend.md#one-table-for-route-metadata) | pkm-77w2 |
| One edit in the journal re-renders every mounted outline | Anything sharing a context identity with `pending` wakes every consumer. A consumer uses the narrowest of `SyncProvider`'s four hooks | [frontend.md § State management](architecture/frontend.md#state-management) | pkm-qfee |
| Block rows re-render with no DOM change | `EditableBlock` is memoised on props that `EditableBlockTree` keeps stable. A prop with a new identity each render defeats the memo | [frontend.md § State management](architecture/frontend.md#state-management) | pkm-qfee |
| An assistant reply shows a block citation as literal `((^uid))` text instead of a link | The model copied the `^uid` marker from tool output into the citation. `stripCaretBlockRefs` runs on assistant text before `tokenizeBlock` | [frontend.md § The assistant panel](architecture/frontend.md#the-assistant-panel) | pkm-wx86 |
| Tapping a PDF in the iOS standalone PWA replaces the whole app with the PDF, with no way back | `ExternalLinkInterceptor` ignores same-origin `target="_blank"` anchors. PDF cards open the in-app `PdfViewer` overlay | [frontend.md § The /files browser](architecture/frontend.md#the-files-browser) | pkm-5o11 |

## Editor

Owner: [frontend-editor.md](architecture/frontend-editor.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Opening a freshly created `[[ref]]` with Ctrl-O/Ctrl-Shift-O empties the source block | The unmount-only draft flush races `POST /api/pages`. `ensureRefPageThenOpen` flushes the draft before creating the page and navigating | [frontend-editor.md § Drafts and commit points](architecture/frontend-editor.md#drafts-and-commit-points) | pkm-hhbc |
| Shift-Up/Down with a text selection at a block's edge collapses the selection and jumps to the neighbouring block | The boundary-arrow branch excluded Meta/Ctrl/Alt but not Shift, so a growing selection fell through to block navigation. It must escalate to a block selection | [frontend-editor.md § Rules an edit must not break](architecture/frontend-editor.md#rules-an-edit-must-not-break) | pkm-jgtn |
| A multi-block selection made while editable stays deletable after the outline switches to read-only | Backspace/Delete called `onDeleteBlockSelection()` unconditionally. Every mutating selection branch must check `!readOnly` | [frontend-editor.md § Rules an edit must not break](architecture/frontend-editor.md#rules-an-edit-must-not-break) | pkm-rckh |
| After `/upload` the block stays a textarea, and the image or document appears only once the cursor leaves the line | The path relied on the native file dialog blurring the textarea, which browsers do not guarantee. The `/upload` pick blurs the block itself before opening the picker | [frontend-editor.md § Rules an edit must not break](architecture/frontend-editor.md#rules-an-edit-must-not-break) | pkm-zrjc |
| Typing on a big page burns a fifth of a CPU core, mostly in layout | The textarea auto-grow reset height to `auto` and re-measured on every keystroke, forcing layout twice per character. `textareaHeight.ts::mayHaveShrunk` gates the reset | [frontend-editor.md § Which way the editor's dependencies point](architecture/frontend-editor.md#which-way-the-editors-dependencies-point) | pkm-youp |
| Selecting a word and typing `[[` wraps it as `[[word]]` but the ref popup never opens, while typing `[[wor` does | The key-edit path and `resolve` read `selectionStart`, which sits right after the `[[` and so sees an empty query. Both must read `selectionEnd` | [frontend-editor.md § Autocomplete](architecture/frontend-editor.md#autocomplete) | pkm-wxwp |
| `PageView` and a sidebar panel behave differently on the same page: one reloads on resync and the other doesn't, or one loses a read | A second copy of the read lifecycle drifts from the first. Both single-page surfaces go through `outline/useOutlinePageLoad.ts` | [frontend-editor.md § Driving a session from a view](architecture/frontend-editor.md#driving-a-session-from-a-view) | — |
| A `((uid))` ref typed in a sidebar panel stays unresolved until the panel remounts | The sidebar mounted the bare `BlockRefContext.Provider`, so nothing watched for newly resolved texts. Outline surfaces mount `BlockRefProvider` | [frontend-editor.md § Driving a session from a view](architecture/frontend-editor.md#driving-a-session-from-a-view) | pkm-0one |
| Scrolling the journal issues one `GET /api/page` per day on screen | Each day fetched its own linked references. They arrive with the day in `/api/journal`'s payload | [frontend-editor.md § Journal day references](architecture/frontend-editor.md#journal-day-references) | pkm-5fak |

## Rendering

Owner: [frontend-rendering.md](architecture/frontend-rendering.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Two mermaid diagrams on one page clobber each other's rendered SVG | Stock mermaid's `render()` looks up its render id in `document`, so two fallback diagrams mounting in the same commit need distinct real ids. Only the cached copy is normalised to `MERMAID_CACHE_RENDER_ID`; `withRenderId` restores each instance's own id | [frontend-rendering.md § Mermaid](architecture/frontend-rendering.md#mermaid) | pkm-pekk |
| The references popover renders clipped off the right window edge, with no scrollbar to reach it | Its fixed position used the badge anchor as-is. The popover clamps its measured rect into the viewport (`popoverPosition.ts`) | [frontend.md § Popovers and menus](architecture/frontend.md#popovers-and-menus) | pkm-7iv7 |

## Styling

Owner: [styling.md](architecture/styling.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| On a phone, Tab lands on invisible controls before anything visible | The closed drawer used `transform: translateX(-100%)` alone, which leaves its links as the page's first tab stops. It must also toggle `visibility` | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-cq32 |
| Page-title rename and the Unlinked references collapse cannot be reached from the keyboard | `onClick` sat on a non-focusable `<h1>`/`<h2>`. The label must be a real `<button>` inside the heading | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-cq32 |
| A bullet menu or references popover in the journal opens hundreds of pixels from the pointer | A `content-visibility` (or `contain: layout`) ancestor becomes the containing block for the fixed surface. Both surfaces portal to `document.body` | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-muka |
| On iPadOS Safari a PDF block's row runs hundreds of pixels past its footer, leaving a blank gap until a reload or tab switch | A layout-contained box has no baseline. Without `contain: layout` on `.pdf-frame`, the baseline-aligned `.block-row` takes its baseline from a canvas inside the `.pdf-frame` scroller | [styling.md § Focus and interactive affordances](architecture/styling.md#focus-and-interactive-affordances) | pkm-vg3y |

## Sync and offline

Owner: [sync-and-offline.md](architecture/sync-and-offline.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A flapping link refetches every mounted view after each 2 s blip | `resyncSeq` was bumped after every successful reconnect, even when the catch-up applied nothing | [sync-and-offline.md § Ancillary details](architecture/sync-and-offline.md#ancillary-details) | pkm-5fak |
| Every retry of the OPFS open fails instantly with the same error | The memoised-rejection trap: `forceReinitIfPreviouslyFailed` was dropped from `SAH_POOL_INSTALL_OPTIONS` | [sync-and-offline.md § When the replica cannot be opened](architecture/sync-and-offline.md#when-the-replica-cannot-be-opened) | pkm-wi25 |
| Reads work; every edit fails `SQLITE_CANTOPEN` | The pool installed at capacity 1, and the top-up to `MIN_POOL_CAPACITY` is missing or ran too late | [sync-and-offline.md § When the replica cannot be opened](architecture/sync-and-offline.md#when-the-replica-cannot-be-opened) | pkm-ndcu |
| Two replicas on one iPad stall at the same `since=`, both logged under one IP | A home-screen PWA has its own storage partition. Safari and the PWA hold independent replicas, cursors and queues | [sync-and-offline.md § When the replica cannot be opened](architecture/sync-and-offline.md#when-the-replica-cannot-be-opened) | — |
| "Server rejected a change" and the outline reverts, but the server is healthy | A *local* storage failure reached `onDesync`. Retention is a blocklist on `rejected`, so an unrecognised storage failure is retained by default; the old whitelist matched on error message | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-c9hp, pkm-s7af |
| After reconnect, durable delivery never resumes and the drain never reports `"drained"` | The drain kept calling a dead replica. It assumes no repeated OPFS open, which holds only because of the worker's latch. Do not fix this by re-arming the DB | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-9x6u |
| Every replica write fails with a bare `disk I/O error` and nothing says the disk is full | The opfs-sahpool VFS catches `SyncAccessHandle.write()`'s `QuotaExceededError`, keeps it private and returns `SQLITE_IOERR`. A full disk looks like any other write failure, so a read-only "storage full" mode has no signal to trigger on | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-avag |
| A profile stays wedged across sessions after a rejected batch | The retained mark intent in `localStorage` clears only after a successful `markPoisoned`, which an unopenable replica cannot do. The banner's "Discard rejected change" releases it | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-tu5k |
| Unsent edits are reported, and it is unclear whether the recovery barrier or the network is to blame | Lane ops with no durable queue look the same in both cases. The barrier case clears when the barrier lifts; the offline case clears only by reconnecting before the tab closes | [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) | pkm-bjae |
| Startup wedges: edits accepted, nothing delivered, socket up | The recovery barrier was held on an RPC that could never answer, and the lane was never drained | [sync-and-offline.md § Availability: two values, one owner](architecture/sync-and-offline.md#availability-two-values-one-owner) | pkm-bjae |
| Unsent edits vanish on reload in an online-only session | The lane is their only home. `useUnloadGuard` interrupts the reload, but an iOS standalone PWA ignores `beforeunload`, so on iPad the banner's Reload confirm is the only warning | [sync-and-offline.md § The in-memory fallback lane](architecture/sync-and-offline.md#the-in-memory-fallback-lane) | pkm-bjae, pkm-0htf |
| "Server rejected a change (HTTP 400)" on reconnect, from a `create` of a uid that already exists | A lost enqueue reply split one batch into two ids: the worker minted the durable row's id, the lane copy got a fresh one, and replay dedup never matched. The id is now minted on the main thread and shared | [sync-and-offline.md § The in-memory fallback lane](architecture/sync-and-offline.md#the-in-memory-fallback-lane) | pkm-ybgt |
| With two tabs open, one tab's `update_text` overwrote the other's with no `[[conflict]]` sibling | The op carried no `base_text_hash`, so the server took its legacy branch: plain last-write-wins | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-4ubd |
| A collapse made offline reorders recently-changed lists, then un-reorders on resync | One side stamped `updated_at` for `set_collapsed` and the other did not | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-r7k8 |
| A breadcrumb read offline differs from the same read online; descendants orphaned after an offline delete or cross-page move | Both of the replica's recursive walks had a `depth < 100` cap | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-8kw2 |
| A page renamed or merged away comes back under its old title a few seconds later, with a `[[conflict]]` sibling on a block that referenced it | Another device held an unsynced edit to a block the rename rewrote, and last-write-wins applied its stale text, `[[title]]` and all. The rename is now replayed over incoming text first, so that edit lands under the new title. A block edited again after the rename still forks a `[[conflict]]` sibling, with the new title in both texts | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-n31j, pkm-x5w0 |
| Offline for ~30 s shows "Local sync is stuck … Reset local data" instead of plain Offline | `OfflineError` (status 0, thrown when the offline gateway has no local route for a request) extends `ApiError`, so the stall classifier's `instanceof ApiError` check treated it as a server rejection | [sync-and-offline.md § Offline editing and reconnect](architecture/sync-and-offline.md#offline-editing-and-reconnect) | pkm-gw5r |
| A deleted page keeps showing in replicas until some unrelated edit | A journal-advancing route committed without nudging. Add every such route to `test_journal_advancing_contract.py` | [sync-and-offline.md § Post-commit nudges](architecture/sync-and-offline.md#post-commit-nudges) | pkm-getl |
| "Local sync is stuck: … UNIQUE constraint failed: pages.title" (or `sidebar_entries.title`), and the server log shows the same `changes?since=` window refetched with growing backoff | The window upserted pages before its tombstones. A merge deleted a page, a stale client re-created its title under a new id, and both landed in one window, so the new row collided with the local row still holding the title. Tombstones now lead and colliding titles are parked | [sync-and-offline.md § The changes feed](architecture/sync-and-offline.md#the-changes-feed) | pkm-n31j |
| "Local sync is stuck: … FOREIGN KEY constraint failed", and Reset local data churns | A changes window shipped a block whose `parent_uid` or `page_id` no window had delivered, or `reapplyPending` re-created a pending block under a row the feed removed. Deferred FKs surface both only at COMMIT, past the savepoints | [sync-and-offline.md § Rebootstrap triggers](architecture/sync-and-offline.md#rebootstrap-triggers) | pkm-qvlx |
| "Local sync is stuck: SQLITE_CORRUPT_VTAB … database disk image is malformed", cleared only by a manual Reset local data | The FTS5 index disagrees with `blocks`/`pages`. FTS5 raises 267 when a delete would push its row or token totals below zero. A rebase would replay the same triggers over the same index, so corruption gets one automatic `reset` per session and is not classified as a stall | [sync-and-offline.md § Rebootstrap triggers](architecture/sync-and-offline.md#rebootstrap-triggers) | pkm-n31j |
| A first-ever offline load with an empty op queue never bootstraps; views stay empty until a manual reload | The first-connect gate checked only the pending-op count, so a mount-time bootstrap that failed offline was never retried when connectivity returned | [sync-and-offline.md § Ancillary details](architecture/sync-and-offline.md#ancillary-details) | pkm-8k2c |

## Assistant

Owner: [assistant.md](architecture/assistant.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| The assistant never calls any pkm tool; every turn is plain text | With `tools=[]`, the SDK hides MCP tool discovery behind its own ToolSearch meta-tool unless `ENABLE_TOOL_SEARCH=false` is set | [assistant.md § Harness confinement](architecture/assistant.md#harness-confinement) | pkm-wn2s |
| Every assistant `batch` approval card reads `batch: 0 operation(s)`, so writes are approved unseen | The preview read an `ops` key that the tool never sends (`batch` takes `commands`), and its unit test asserted the same invented shape. A payload the preview cannot parse falls back to a dump of every argument; check a changed tool's preview against a live payload | [assistant.md](architecture/assistant.md) (`policy.py`) | pkm-y3rr |
| A large write gets no confirmation card, and the harness stays parked until the server restarts | The SSE stream was silent for over a minute while the model reasoned and serialised the call, so an idle timeout dropped it and the confirm frame went to a dead socket. Disconnect cleanup then awaited `interrupt()` before declining the parked confirmation, which it never reached. A keepalive frame now runs every `KEEPALIVE_INTERVAL_S`, and cleanup declines first, then interrupts with a bounded wait | [assistant.md § Conversation registry](architecture/assistant.md#conversation-registry) | pkm-mbcc |
| A tab closed mid-turn leaves the conversation in the registry with its harness subprocess and 0600 token file alive, and a later turn is handed that harness | The SSE layer stopped iterating without closing the event stream, and the response task's repeated cancellation cut the bounded interrupt short | [assistant.md § Conversation registry](architecture/assistant.md#conversation-registry) | pkm-f3mo |
| The panel sits at "thinking…" on a dead network until a manual Stop | The SDK's model request has no first-token timeout, and nothing tells a stuck request from a thinking model | [assistant.md § Keepalives and the stall watchdog](architecture/assistant.md#keepalives-and-the-stall-watchdog) | pkm-e9ok |
| A new MCP tool works from the CLI and Claude Code but the in-app assistant says it lacks permission | The assistant allows only tools named in `READ_TOOLS`/`WRITE_TOOLS` (`policy.py`) and denies the rest. `test_every_mcp_tool_is_classified` now fails when a registered tool is in neither | [assistant.md](architecture/assistant.md) (`policy.py`) | pkm-6eea |

## CLI and MCP

Owner: [cli-and-mcp.md](architecture/cli-and-mcp.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| `--section "## Notes"` returns an H3 or a plain block | A marked spec matches heading level and text together. Only a bare spec (`Notes`) matches any level | [cli-and-mcp.md § Section selection](architecture/cli-and-mcp.md#section-selection) | — |
| A heading copied from `pkm todos`/`search`/`refs` output and written back with `pkm update` silently becomes plain text | Those verbs' response models have no `heading` field, so they print bare text (a snippet, for `search`). Only `pkm get`/`get_page`/`get_block` round-trip a heading | [cli-and-mcp.md § Heading round trip](architecture/cli-and-mcp.md#heading-round-trip) | — |
| `pkm get -abc123` or `pkm update -abc123` fails with an unknown-option error | argparse reads a leading-`-` uid as a flag. Put `--` before the uid (`pkm get -- -abc123`), with `pkm update`'s `-D`/`-T` flags before the `--` | [cli-and-mcp.md § Writes, uids and missing pages](architecture/cli-and-mcp.md#writes-uids-and-missing-pages) | — |

## Performance checks

Owner: [performance-checks.md](architecture/performance-checks.md)

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| A frontend check fails with `port 8977 is in use` while no other perf check is running | An orphaned fixture server. It runs in its own process group, so a hard-killed `run.py` leaves it holding the port. Find it with `lsof -iTCP:8977` and stop it; never move the check to 8974 or 8975 | [performance-checks.md § Shared state](architecture/performance-checks.md#shared-state) | pkm-uxop |
| A frontend confirmation times out in setup, waiting for `pkm:replica-ready`, at the merge-base run | The merge base's SPA predates the `pkm:replica-ready` mark in `replicaSync.ts`. The branch's `check.mjs` needs it to time replica readiness and to know a context is ready | [performance-checks.md § Confirmation](architecture/performance-checks.md#confirmation) | replicaSync.test.ts |
