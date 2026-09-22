# Frontend architecture (web/)

The frontend is a React 18 + Vite single-page app: an offline-capable,
real-time-synced Roam-style outliner. Two things shape almost every file:

1. **FCIS is machine-enforced.** Every runtime module declares
   `// pattern: Functional Core` or `// pattern: Imperative Shell`;
   `pnpm check:fcis` (`web/tooling/fcis.mjs`) fails if a Core module imports
   a Shell. Most subsystems are a pure state machine ("core") plus a thin
   React/worker/fetch "shell" that gathers inputs, dispatches, and runs the
   returned effects.
2. **The server is the source of truth for shapes.** API types are generated
   from the server's OpenAPI schema, the replica schema is generated from
   the server's DDL, and the Roam-markdown grammar is pinned to the Python
   parser by shared fixtures.

See [overview.md](overview.md) for the system picture and
[sync-and-offline.md](sync-and-offline.md) for the sync engine and replica in
depth. The outline editor is [frontend-editor.md](frontend-editor.md) and the
read path is [frontend-rendering.md](frontend-rendering.md). Failures and their
fixes are indexed by symptom in [troubleshooting.md](../troubleshooting.md).

## Tech stack

| Concern | Choice |
|---|---|
| UI | React 18.3, react-router-dom 6.30 (v7 future flags), TypeScript 5.9 |
| Build | Vite 6, `vite-plugin-pwa` (Workbox service worker), pnpm (overrides in `pnpm-workspace.yaml` — pnpm 11 ignores `package.json` overrides) |
| Offline | `@sqlite.org/sqlite-wasm` (replica in a Web Worker on the OPFS SAHPool VFS) |
| Rendering extras (all lazy-loaded) | KaTeX (math), beautiful-mermaid + Mermaid fallback (diagrams), react-pdf/pdf.js (PDF viewer), highlight.js (code) |
| Tests | Vitest + jsdom (enforced coverage), Playwright e2e, Testing Library, type-aware ESLint |
| API types | `openapi-typescript` via `pnpm gen-types` |

## Module map (`web/src/`)

```
web/src/
├── main.tsx / App.tsx        Shell        Entry; provider nesting (SyncProvider > Dnd >
│                                          Sidebar > BlockStamps); routes; the single
│                                          window keydown listener for the global chords
├── routeMeta.ts              Core         Path / top-bar label / browser title per
│                                          static route (see Views and navigation)
├── useRouteTitle.ts          Shell        The one route-aware document.title effect
├── blockStampsPref.ts        Core         Block-timestamps preference: key, guard, toggle
├── useBlockStampsPref.ts     Shell        Owns the single instance behind BlockStampsContext
├── uid.ts / uidCore.ts       Shell/Core   uid minting; the alphanumeric-first rule
├── theme.ts / useTheme.ts    Core/Shell   Theme cycle; data-theme stamping
├── useEffectiveTheme.ts      Shell        Resolved theme observed from the DOM
│                                          (data-theme MutationObserver + media
│                                          query) for consumers that must react
│                                          to flips; useTheme state is per-component.
│                                          One shared module-level observer pair
│                                          backs every call (useSyncExternalStore),
│                                          not one per subscriber
├── popoverPosition.ts        Core         clampPopoverPosition — viewport clamping
├── Popover.tsx               Shell        The shared anchored-popover chrome
├── useDismiss.ts             Shell        Outside-mousedown + Escape dismissal
├── useStoredPref.ts          Shell        One localStorage preference: guard-checked
│                                          read, write-back, fallback on either failure
├── useStaleGuard.ts          Shell        begin/cancel/isStale for surfaces holding at
│                                          most one live request (SearchBar, QueryBlock,
│                                          useTitleOptions); Files keeps its own
├── useScrollFlashTarget.ts   Shell        Scroll a data-uid into view and flash it,
│                                          document-wide or scoped to a panel root
├── externalLink.ts           Core         iOS-standalone predicate; click → x-safari-
│                                          http(s) URL decision (see below)
├── styles.css                —            All styling — owned by styling.md
│
├── api/                      The typed HTTP layer (see API layer)
│   ├── client.ts             Shell        apiFetch: JSON, 401 → /login, offline gateway
│   ├── typedClient.ts        Shell        apiGet/apiPost/…, typed by the OpenAPI paths
│   └── openapi.json, types.d.ts (generated); ops.ts, payloads.ts (type-only re-exports)
│
├── grammar/                  Roam-markdown parsing (see frontend-rendering.md)
│   ├── scan.ts               Core         THE scanner; mirrors server refs.py,
│   │                                      fixture-pinned
│   ├── tokenize.ts           Core         Token stream → BlockSegment[] for rendering
│   └── refs.ts, todo.ts, snippet.ts, markdown.ts, linkReference.ts — Core adapters
│
├── outline/                  The editor engine (see frontend-editor.md)
│   ├── handlers.ts           —            OutlineHandlers, the command port (types only)
│   ├── outlineState.ts       Core         transitionOutline — the session reducer
│   ├── tree.ts               Core         applyOps; mirrors the server's op semantics
│   ├── edits.ts / keyEdits.ts  Core       Structural and in-block edit planning
│   ├── keyboardPolicy.ts     Core         Keystroke → semantic KeyDecision
│   ├── autocomplete.ts / refAtCaret.ts  Core  Completion contexts; live-caret rules
│   ├── slashCommands.ts / calendar.ts   Core  Slash commands; the /date month grid
│   ├── blockSelection.ts / history.ts / paste.ts / dnd.ts  Core  Selection, undo
│   │                                      history, outline paste, drag planning
│   ├── blockStamps.ts        Core         Stamp bands; which ops count as a change
│   ├── baseTextHash.ts       Core         Stamps update_text ops at build time
│   ├── textareaHeight.ts     Core         Auto-grow reset/write decisions (JS fallback)
│   ├── missingPage.ts        Core         The missing-page policy (see frontend-editor.md)
│   ├── useOutline.ts         Shell        Implements OutlineHandlers
│   ├── loadOutlineBlocks.ts  Shell        The one blocks-only page read behind every
│   │                                      registered authoritative loader
│   ├── outlineSessions.ts    Shell        Per-title shared sessions (see State management)
│   ├── parentReadElection.ts Shell        Who starts a title's next parent read
│   ├── repairEpochs.ts       Shell        The global post-settlement repair pass
│   ├── useOutlinePageLoad.ts Shell        The shared single-page load controller
│   ├── useBlockDraft.ts      Shell        The focused block's draft session
│   ├── useAutocomplete.ts    Shell        The popup's shared state
│   ├── undoManager.ts        Shell        Undo/redo dispatch; re-stamps hashes at replay
│   └── caretDisplayLine.ts   Shell        Caret geometry reads
│
├── components/               ~45 Shell files: the editor's views (EditableBlockTree,
│   │                         BlockInput), inline renderers (InlineSegments, MathSpan,
│   │                         QueryBlock, BlockRef, MermaidDiagram, PdfViewer, CodeBlock,
│   │                         roamTable, TableOfContents…) and chrome (TopBar, SidebarNav/Panel, SearchBar,
│   │                         OfflineIndicator, Composer, BacklinksSection, BacklinkGroupList,
│   │                         BlockRefBacklinksPopover, BlockMenu, DatePickerPopup…)
│   ├── ExternalLinkInterceptor.tsx  Shell  Capture-phase document click listener,
│   │                                       mounted only in iOS standalone (see below)
│   └── pure halves           Core         Beside their component: pdfViewerCore,
│                                          roamTableRows, tocEntries, backlinkFilter, groups,
│                                          backlinkBatchWalk, bluesky, mermaidTheme,
│                                          blockRefStore…
│
├── views/                    One Shell file per route (see Views and navigation);
│   │                         EditablePage = one editable outline, shared by the main
│   │                         pane and sidebar panels
│   ├── FileCardPopovers.tsx  Shell        /files card popovers: refs, description
│   └── filesCore.ts          Core         /files queries, MIME buckets, confirm text
│
├── assistant/                The chat panel UI (see The assistant panel)
│   ├── sse.ts                Core         Incremental SSE frame parser
│   └── client.ts / useAssistant.ts / AssistantPanel.tsx — Shell: stream, state, panel
│
├── sync/                     Delivery + connectivity (see sync-and-offline.md)
│   ├── SyncProvider.tsx      Shell        The global context; repair orchestration
│   ├── useSocketLifecycle.ts Shell        Connect lifecycle: pending bootstrap,
│   │                                      socket status, StrictMode teardown
│   ├── reconnectFlow.ts      Shell        Reconnect single-flight: drain → pull →
│   │                                      resync, shared with the drain observer
│   ├── opQueue.ts            Shell        Durable-queue driver (+ queueState.ts Core)
│   ├── replicaSync.ts        Shell        Cursor pull loop
│   ├── socket.ts             Shell        WebSocket + reconnect: no scheduled
│   │                                      attempts while hidden, hurried on
│   │                                      visible or `online` (rate-limited);
│   │                                      backoff resets only on proof of life,
│   │                                      not on open; a long-hidden resume
│   │                                      closes a socket that OS-froze but
│   │                                      still reports OPEN, handing it to
│   │                                      the normal reconnect path
│   ├── reconnectBackoff.ts   Core         Reconnect delay: 2 s doubling to a 30 s cap
│   ├── syncState.ts          Core         Editability/health FSM
│   ├── retryPolicy.ts        Core         Which recovery a banner Retry means
│   └── assets.ts             Shell        Multipart upload
│
├── replica/                  The offline engine (see sync-and-offline.md)
│   ├── worker.ts / workerHandlers.ts  Shell  The worker; db()'s latched open
│   ├── rpc.ts / client.ts    Shell        Typed RPC over the worker port
│   ├── queue.ts / apply.ts / reconcile.ts / recoveryGate.ts  Shell  Pending ops, feed
│   │                                      apply, negative-id remap, recovery FIFO
│   ├── localApi/             Shell        Offline read shims: the routes' exact JSON
│   ├── localOps.ts           Shell        Optimistic apply (server timestamp rules)
│   ├── blockRefs.ts          Shell        block_refs re-derivation, shared by both applies
│   ├── errors.ts             Core         The availability taxonomy
│   ├── openRetry.ts / poolCapacity.ts  Core  OPFS open policy
│   ├── titles.ts             Core         Title canonicalization
│   └── baseSchema.gen.ts     —            Generated from the server's BASE_DDL
│
├── dnd/                      Shell        Drag-and-drop context + drop zones
│   └── dropGeometry.ts       Core         Boundary/indicator from measured rects
└── contexts.ts, sidebar.ts, paths.ts, router.ts, help/ — small shared modules
```

### External links in the iOS standalone app

An installed iOS/iPadOS home-screen app opens external links in the in-app
WKWebView overlay, and Apple offers no supported way to change that.
`ExternalLinkInterceptor` (mounted in `App.tsx` next to `UndoRedoKeys`)
attaches a capture-phase `document` click listener only when
`externalLink.ts`'s `isIosStandalone` predicate holds. It rewrites the click's
navigation to the undocumented `x-safari-https://`/`x-safari-http://` scheme,
which hands the URL to the real Safari app. Hrefs stay canonical `https://`, so
copy link, share and every other browser are unaffected.

## Views and navigation

There are seven routes:

| Route | View |
|---|---|
| `/` | Journal — an infinite scroll of daily pages |
| `/page/*` | PageView — one page |
| `/current-work` | Recently edited pages |
| `/files` | The asset browser |
| `/settings` | Whole-database export, and future settings |
| `/help` | The static keyboard-shortcut doc |
| `*` | NotFound |

### One table for route metadata

`routeMeta.ts` holds the path, top-bar label and browser title for every
static route. Three places read it: `App.tsx`'s `<Routes>` and `NavLink`s,
TopBar's label and page-action-menu gating, and `useRouteTitle.ts` — the
single route-aware `document.title` effect, called once from `App`. A route
therefore cannot end up labelled in one place and not another.

`routeMetaFor` strips trailing slashes from non-root static paths before
lookup, so a hand-typed `/files/` or `/settings/` still gets the canonical
label and title. `/page/*` and the not-found catch-all are the two routes
with no entry: `/page/*` is dynamic, so `PageView.tsx` sets its own title
once the page's title has loaded, which the pathname alone cannot give it.

### Navigation chrome

The left nav holds the pinned pages (server-persisted through `/api/sidebar`),
then a rule-fenced block of app destinations — Assistant, Files, Settings —
and the theme toggle. The right-hand sidebar is a session-only stack:
shift-clicking any page link or ref pushes a `SidebarPanel` onto it.

**No link in the left nav may leave shift-click to the browser.** react-router
ignores modified clicks (`shouldProcessLinkClick` bails on `shiftKey`), so a
bare `NavLink` hands the shift-click to the browser instead of opening the
sidebar. Both nav link components therefore handle it, and new nav links must
use one of them rather than `NavLink` directly:

- `NavPageLink` — destinations that *are* pages (the pinned entries, TODO):
  opens the page in the sidebar, same contract as `PageLink` inline.
- `NavRouteLink` — destinations that aren't (Daily Notes, Current Work, Files,
  Settings): swallows the click and does nothing. A panel renders a page *by
  title* and no page sits behind these routes, so there is nothing better to
  offer; it also leaves `onNavigate` unfired, so a phone drawer stays open
  rather than closing onto nothing.

Four global keys, all in one `window` keydown listener in `App.tsx`:
`Ctrl+Shift+D` jumps to today's daily note, `Cmd/Ctrl+/` toggles the sidebar,
`Cmd/Ctrl+J` toggles the assistant panel, and `Ctrl+Shift+T` toggles the
block-stamp column.

- The Ctrl+Shift family exists because the Cmd forms never arrive. macOS
  reserves `Ctrl+Cmd+D` for dictionary lookup, and the browser owns `Cmd+T`
  (new tab) and `Shift+Cmd+T` (reopen closed tab). In each case the page
  receives no keydown at all, so no handler can claim the chord. Plain
  `Ctrl+letter` is not available either, since [keyboard.md](../keyboard.md)
  leaves the emacs-style bindings to the browser. Both Ctrl+Shift chords
  carry a `!e.metaKey` guard so adding Cmd doesn't also fire them.
- No test can tell you a chord is swallowed: jsdom and Playwright both deliver
  a synthetic keydown the real OS or browser would have eaten. Confirm a new
  global chord by pressing it in the running app before merging.
- These chords fire while a block is being edited, because `BlockInput` does
  not `stopPropagation` on keydown and the listener is on `window`. Adding a
  propagation guard to the editor would break all four.

`Ctrl+Shift+T`'s target is `blockStampsPref`, one global setting rather than a
per-page one. It stays live off page routes too: pressing it on `/files`
takes effect on the next page opened, even though the page menu only offers
the item on `/page/*`.

The main pane and a sidebar panel can show *the same page at the same time*.
That fact drives the per-title outline sessions below.

### Popovers and menus

`Popover.tsx` is the chrome every anchored popover renders through: a
`role="dialog"` on `.block-ref-popover`, `position: fixed` at its anchor
point, measured after layout and clamped inside the viewport by
`clampPopoverPosition`. An overflowing fixed element grows no scrollbar to
recover it, so the clamp is what keeps the surface reachable. Its one prop
that is not chrome is `remeasure`: the caller's values whose change resizes the
content and so invalidates the clamp. A re-render the caller did not declare
there is not re-measured, so a popover cannot drift under the pointer.

Both `Popover` and `BlockMenu` render through `createPortal` into
`document.body`. Their coordinates are the viewport's, and `position: fixed`
only resolves against the viewport while no ancestor imposes layout
containment ([styling.md](styling.md) owns that invariant). The portal moves
the DOM node, not the React node, so synthetic events still bubble to whatever
rendered the surface — treat a portalled surface as an interactive island and
stop its own clicks, as `PdfViewer`'s overlay does.

`useDismiss(ref, onDismiss, options)` is the dismissal half on its own: a
`mousedown` outside `ref`, or Escape, closes the surface. Both listeners sit
on `document`, so dismissal still works once focus has left the surface, and
the surface goes on press rather than on a release that may never land over
it. `enabled` is for a surface whose component stays mounted while closed;
`preventDefaultOnEscape` for one that claims the keystroke outright.

| Surface | Chrome | Dismissal |
|---|---|---|
| `BlockRefBacklinksPopover`, `FileCardPopovers` | `Popover` | `Popover`'s own `useDismiss` |
| `BlockMenu` | `.block-menu` | `useDismiss`; roving focus and Tab stay in the component |
| `TopBar`'s page menu, `SearchBar` | own markup | `useDismiss` with `enabled` |
| `ConfirmDialog`, `ImageOverlay` | own modal markup | hand-rolled: `window` listener, Enter/Tab, scroll lock, focus restore |
| `AutocompletePopup`, `DatePickerPopup` | own markup | none of their own — `BlockInput` owns their keys |

Hand-roll dismissal only for a modal surface, or one whose keys another
component owns. **Modal** here means it traps focus, locks page scrolling, or
answers keys beyond Escape.

### The `/files` browser

`/files` is a plain table over `/api/assets/search`, with filters (text over
filename and description, type, date range, linked/orphan), offset pagination,
and multi-select for delete and zip export.

Cards are interactive. An image thumb expands in the shared `ImageOverlay`
(extracted from `AssetImage`). A PDF thumb opens `PdfViewer` in its
overlay-only mode (the `onClose` prop) through the lazy `PdfEmbed` shim, so
PDFs open in-app on every surface. Document and other thumbs stay plain
new-tab anchors; the server serves those MIME types as
`Content-Disposition: attachment`, so the browser downloads them instead of
navigating. The refs and described/failed status badges open popovers
(`views/FileCardPopovers.tsx`): the refs popover fetches block text through
`GET /api/block-refs` — chunked at its 50-uid cap by `filesCore.refUidChunks`
— and renders through `BacklinkGroupList`, the single renderer every backlinks
surface uses. Media inside popover rows renders inert (`InertMediaContext`),
so the whole row stays a click target. `orphan` and `pending` badges stay
inert spans.

Pagination has two guards. A synchronous single-flight lock, alongside the
disabled button state, stops a double click issuing two page requests; a
generation guard discards responses that a filter change has made stale.

Its pure half, `views/filesCore.ts`, owns the typed query-object building,
MIME categorisation, size formatting, confirm-text composition, the
reference token a user can copy into a block, and the ref grouping behind
the refs popover (`refGroups`, `refUidChunks`). `typedClient` serializes the
query; the shell owns fetching, selection state and the download. The zip
export is submitted as a throwaway hidden `<form method="post">` rather than a
fetch, so the browser owns the download instead of the SPA buffering it.

## State management

There is no Redux/Zustand; state lives in three layers:

1. **Server payloads per view** — components fetch JSON through the typed
   client (`apiGet`/`apiPost`/`apiPut`/`apiDelete`) and hold results in
   local state, refetching when told to.
2. **`SyncProvider`** (`sync/SyncProvider.tsx`) — four contexts, one per rate
   of change. React cannot subscribe to part of a context value, and the
   Journal mounts one outline per loaded day, so **anything sharing an
   identity with `pending` re-renders every mounted outline twice per flushed
   edit**. A consumer takes the narrowest hook it can:

   | Hook | Value | New identity when |
   |---|---|---|
   | `useSyncActions()` | `enqueue`, `subscribe`, `settled`, `attachOutlineReplay`, `retryProblem`, `dismissProblem`, `discardProblem`, `resetReplica` | never: one object per provider, because each method reads current state through a ref |
   | `useResyncSeq()` | `resyncSeq` | server state may have diverged (reconnect after a gap, repair finished) |
   | `useSyncEditability()` | `canEdit`, `readOnlyReason` | editing becomes allowed or blocked; a flap with a ready replica changes neither |
   | `useSyncHealth()` | `status`, `replicaMode`, `pending`, `unsentInMemory`, `problem` | the socket flaps, or an op is queued or acknowledged |

   Views subscribe to the counter through `useResync(fn)` and refetch on each
   bump. There is no whole-value hook. Tests inject a complete `Sync` through
   `SyncContext`, which every hook prefers when set; the provider itself
   publishes only the four slices.

   A row is guarded the same way one layer down: `EditableBlock` (in
   `EditableBlockTree.tsx`) is memoised behind props the tree holds stable, so
   a parent re-render with unchanged props re-renders no row. A changed
   context identity is what reaches a row instead.

   `pending` has exactly one publisher, the op queue: it suppresses a re-emit
   of a count that did not move, so a second writer of that state would turn
   the suppression into a banner stuck on a stale number. Anything that
   changes the durable queue behind the queue's back — a previous session's
   rows at mount, a write the offline shim enqueued inside the worker — calls
   `queue.refreshPending()` rather than reading the replica itself.
3. **Per-title outline sessions** (`outline/outlineSessions.ts`) — a
   module-level `Map<title, Session>` external store hands every view of a
   title one ref-counted session, sharing a flushed tree and a monotonic
   revision. Exactly one view holds the editor lease and the others render
   read-only, so the same page in the main pane and the sidebar cannot
   double-edit. That store, its loader election (`parentReadElection.ts`), the
   post-settlement repair pass (`repairEpochs.ts`) and the pure reducer behind
   them (`outlineState.ts::transitionOutline`) are documented in
   [frontend-editor.md](frontend-editor.md).

## API layer

`apiFetch<T>` handles JSON, the 401 → `/login` redirect, and the offline
gateway. Reads also carry a `READ_TIMEOUT_MS` abort signal, so a slow-not-dead
link cannot hold one open indefinitely. Mutations carry none: an
aborted-but-applied write would leave the op queue retrying a batch it cannot
know landed. Nor does the whole-graph `/api/sync/snapshot`, which opts out via
`{ timeoutMs: null }`: its size grows with the graph, so a deadline picked for
small reads would abort a legitimate cold-start bootstrap and restart the same
download forever. Types come from the generated `api/types.d.ts` (`pnpm gen-types`
over `api/openapi.json`, which the server generates); `api/ops.ts` and
`api/payloads.ts` are type-only re-exports. **Never hand-write API types** —
regenerate when the server changes, since the server test suite fails on
stale artifacts.

Concrete JSON requests must use `api/typedClient.ts`'s `apiGet`/`apiPost`/
`apiPut`/`apiDelete`. ESLint enforces that boundary with
`no-restricted-imports`: production and tooling code cannot import `apiFetch`
from `api/client` except at raw transport seams.

The typed client is a typing layer over `apiFetch`, not a second transport.
It builds the same URL and calls `apiFetch`, so the offline gateway and error
behaviour are identical. The difference is that it takes the OpenAPI path
template rather than a built URL:

    apiGet("/api/page/{title}", { path: { title } })

That lets the generated `paths` table decide the path and query parameters,
the JSON request body, and the response type.

Three raw `apiFetch` exceptions exist: the typed-client implementation
itself, multipart upload in `sync/assets.ts`, and `SyncProvider.tsx`'s
`replicaSync` injection seam (`fetchJson: apiFetch`). `SyncProvider` is
allowed for that transport injection only; it does not issue a concrete JSON
request at the import site.

Path parameters are encoded per segment, because `{title:path}` routes carry
namespace titles whose slashes must survive; every other path parameter is
slash-free by construction. Compile-time drift probes live in
`api/typedClient.test.ts` — an expected-error directive that stops erroring
fails the build, so the probes cannot rot.

## Sync and offline (UI-side summary)

The full protocol is in [sync-and-offline.md](sync-and-offline.md). What a
frontend contributor needs day-to-day:

- Edits are optimistic: apply to the outline session, enqueue to a durable
  queue (`pending_ops` rows in the replica DB), deliver FIFO to
  `POST /api/ops`. A `WriteTicket` distinguishes *persisted locally*
  (`settled`) from *acknowledged by server* (`delivered`).
- `api/client.ts::apiFetch` installs an **offline gateway**: when the socket
  is down, or a live fetch throws, reads route to
  `replica/localApi/router.ts` — TypeScript ports of the server's read routes
  returning identical JSON (pinned by `shared/fixtures/shim_parity.json`).
  Unshimmed routes throw `OfflineError`, and their UI says "online only".
- Pages created offline get negative ids, remapped by
  `replica/reconcile.ts` when the authoritative row arrives. When title
  canonicalization activates, the same shell canonicalizes or merges padded
  negative-id pages before pending replay, preserving their blocks, refs and
  unchanged wire operations without leaving divergent padded pages.
- `OfflineIndicator` renders both connectivity state and every *delivery
  problem* `SyncProvider` raises (rejected batch, failed poison marking or
  discovery, replica unavailable). Several banner wordings encode what is and
  is not true of the user's unsent work, so they are documented with the
  mechanisms that decide them, in
  [sync-and-offline.md](sync-and-offline.md#the-replica-and-its-recovery-invariants).
  Change the copy there too.
- The service worker (Workbox, configured in `vite.config.ts`) precaches the
  app shell, sqlite wasm, the pdf.js worker and core KaTeX fonts,
  runtime-caches `/assets/` (CacheFirst, 400-entry LRU), and never caches
  `/api`.

## The editor and the rendering pipeline

Two subsystems have their own docs:

- [frontend-editor.md](frontend-editor.md) — per-title outline sessions and
  their read causality, the textarea editor and the `OutlineHandlers` port,
  keyboard policy, block selection, autocomplete, outline paste, slash
  commands, drag-and-drop, and the Journal's day references.
- [frontend-rendering.md](frontend-rendering.md) — block text to DOM:
  `grammar/scan.ts` as the single grammar authority, the bounded render
  caches, `((uid))` resolution, mermaid, and the PDF embed and viewer.

## The assistant panel

`src/assistant/` is the UI for the server-side LLM assistant; the agent
itself runs on the server (see [assistant.md](assistant.md)). It is a floating
chat panel, toggled with `Cmd/Ctrl+J` (Esc closes) or the "Assistant" sidebar
entry.

- The conversation is created lazily on the first message. The model dropdown
  renders what `GET /api/assistant/models` offers — fetched on first panel
  open, not app load — and locks once the conversation exists. `glm` only
  appears when the server has a z.ai key; `sonnet` / `opus` / `haiku` are the
  fallback if the fetch fails (retried on a later open). Conversations are
  ephemeral: a reload loses them.
- "New chat" deletes the server-side conversation and resets, and is safe
  mid-turn. Each turn carries a generation counter that `newChat` bumps before
  clearing state, so a superseded turn's SSE events and finalizers are dropped
  instead of reaching the fresh transcript.
- A turn streams over SSE. `client.ts::streamMessage` POSTs the message and
  feeds the response body through `sse.ts` (a pure incremental frame parser)
  into `useAssistant.ts`, which folds events into chat items: `text_delta`
  appends to the running assistant bubble, `tool_started`/`tool_finished`
  render tool-activity lines ("searching …"), and `confirm_request` shows an
  Allow/Deny card with the write's ops preview. The tool call is held
  server-side until answered.
- The busy line is `phase` state, not a constant: it shows the server's
  current phase label ("reasoning", "preparing save_note", "replying") or
  "thinking…" before the first one, plus an elapsed clock
  (`elapsed.ts::elapsedLabel`) ticking once a second while status is busy.
  The clock restarts whenever the label changes, when a tool starts, and on
  resuming from a confirm, so a parked approval does not inflate the next
  stretch's elapsed display.
- `sse.ts` drops any frame whose `event:` name is not one of the seven known
  types, which is what makes the server's keepalive comment frames — written
  every 15 idle seconds — invisible here. It also silently drops any newly
  added server event type until `EVENT_TYPES` learns the name.
  `streamMessage` errors the turn if nothing at all arrives for 60 s, so four
  missed keepalives mean the link to the server is dead. That error is not an
  `AbortError`, because `useAssistant` treats one after Stop as success.
- Assistant bubbles render through the shared block grammar
  (`tokenizeBlock` → `InlineSegments`), with `stripCaretBlockRefs`
  (`assistant/normalizeRefs.ts`) applied to the raw text first. Tool output
  labels blocks with trailing `^uid` markers and some models copy the caret
  into their citations; the grammar rejects `((^uid))`, so the fix lives here,
  not in `scan.ts`.
- `streamMessage` bypasses `apiFetch` (which consumes the body as JSON) but
  replicates its 401 handling; the other assistant JSON calls use the typed
  client helpers. The assistant is online-only — `/api/assistant/*` has no
  offline shim.

## Styling

Plain CSS in a single `src/styles.css` — no framework, no CSS-in-JS.
The design tokens, control families, confirmation pattern and
focus/affordance invariants are owned by [styling.md](styling.md). A new
control opts into a named class there; nothing inherits a look silently.

## Testing and quality gates

`pnpm verify` runs the gates in cost order:
**typecheck → lint → check:fcis → test:coverage → budget-enforced build →
Playwright e2e against that build.**

- **Unit** (Vitest + jsdom): co-located `*.test.ts(x)`;
  `src/test-setup.ts` stubs WebSocket/matchMedia/localStorage. Coverage is
  enforced (statements 95 / branches 91 / functions 89 / lines 95), with
  workers and generated files excluded. The pure cores are the payoff of the
  FCIS split: they test with no React, DOM, fetch, worker or SQLite mocks.
- **E2E** (Playwright, `web/e2e/`): thirty specs — editing, backlinks, math,
  rename, undo, embeds, images, PDF, outline paste, slash dates, table of
  contents, journal
  references, the assistant, the `/files` browser, and two offline specs.
  The harness is strict: any HTTP 5xx fails the run (`fixtures.ts`), and a
  server-side exception fails teardown. `e2e/server-state.ts::waitForServerText`
  polls the server's copy of a page, which is the reliable way to wait for a
  write before a reload. The server is launched by `playwright.config.ts`
  (`server/tests/e2e_serve.py`, port `E2E_PORT`, default 8975).
- **Lint** (flat, type-aware ESLint): only two rule families — React Hooks
  correctness, and promise/error safety (`no-floating-promises`,
  `no-misused-promises`, `only-throw-error`, unknown catch variables). There
  are zero `eslint-disable` comments in `web/src`.
- **Budgets** (`web/tooling/budgets.json` + `viteBudgetPlugin.ts`): the build
  fails if the eager entry, largest asset, total output, service-worker
  precache, or the per-library owned bytes (mermaid/pdfjs/katex chunk
  families, attributed by Rollup module reachability) exceed their caps.
  Growing the bundle is an explicit, reviewed decision.
- **Perf harness** (`web/tooling/perf/`, not a gate): Playwright scripts that
  count timers, fetches, WebSocket attempts, forced layouts and CPU under
  idle, degraded-link, typing, multi-tab and journal-scroll scenarios, against
  a seeded throwaway server. Scenarios `J` and `K` instead count React commits
  and re-rendered fibers through a minimal DevTools hook: `J` per keystroke
  with every seeded Journal day mounted, `K` per `dragover` across a 300-block
  page. `K` also times the handler itself, in milliseconds per event. A
  wasted re-render writes no DOM, so no other counter here can see it.
  Numbers are for a human to read against
  `baselines/`; the README has the recipe and the Playwright traps that make
  naive measurements wrong.

## Build notes (`vite.config.ts`)

The dev server proxies `/api` (with WebSocket), `/assets` and `/login` to
the backend (`PKM_API_PORT`, default 8974), so run the server alongside
`pnpm dev`. `@sqlite.org/sqlite-wasm` must stay in `optimizeDeps.exclude`,
because its wasm URL resolution breaks under dep-optimization. Hashed bundles
are emitted under `app-assets/`. The PWA plugin uses `autoUpdate` with
`clientsClaim`/`skipWaiting` and a navigate-fallback denylist for
`/api|/assets|/login`.
