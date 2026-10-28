# Changelog

What changed in `ArthurClune/pkm-system`, one entry per day of work, dated in Europe/London time.

## 2026-07-08 — Foundation and first end-to-end application

Bean tracking had not started; Git is the record for this day.

- Roam import into SQLite with full-text search.
- Read APIs, atomic block operations, and WebSocket sync.
- The first web app: journal, page outlines, queries, search, references, and a sidebar.

## 2026-07-09 — Editing, deployment, and first UX batch

- Editable outlines with live two-client sync, autocomplete, and image upload.
- Markdown export, nightly backups, and launchd deployment.
- Drag-and-drop, sidebar panels, dark mode, slash commands, and keyboard shortcuts.

## 2026-07-10 — Review fixes and broad UI expansion

- A Roam-inspired visual style, top-bar search, collapsible sidebars, Mermaid diagrams, Bluesky embeds, and page deletion.
- Generated API types, type checking, linting, and stronger E2E tests.
- Fixed bugs in database locking, uploads, empty blocks, search, and bare URLs, most found by a code review.

## 2026-07-11 — iPad drag support

- Fixed block drag handles on iPad Safari.

## 2026-07-12 — Offline foundations and editor productivity

- Began offline-first support: a server change journal, snapshot and feed endpoints, idempotent op batches, offline page creation, and conflict copies.
- Multi-block copy, Ctrl-K link wrapping, bracket pairing, `/upload`, block-reference navigation, and cleanup of empty daily notes.
- Enforced test coverage.

## 2026-07-13 — Offline editing completed

- The offline web stack (epic `pkm-y8p0`): a SQLite copy of the database in the browser, a persisted queue of edits, and offline search.
- A PWA service worker caches the app shell and assets.
- Prepared the repository for public release.

## 2026-07-14 — Block presentation and visual polish

- Roam view settings survive import, sync, and export, with numbered and document views, quote blocks, and heading controls.
- Typography, link, icon, and navigation polish.
- Fixed bugs in self-referential queries, numbered lists, and the offline banner.

## 2026-07-15 — Sync and outline reliability

- Fixed sync bugs around recovery, rejected batches, refetches overwriting newer edits, and drag-and-drop replay.

## 2026-07-16 — Architecture hardening, undo/redo, PDFs, and tables

- Web architecture work (epic `pkm-c1cg`): pure editor, sync, keyboard, and outline cores, with enforced boundaries and bundle budgets.
- Undo/redo, keyboard subtree moves, a TODO shortcut, and a search view.
- A PDF viewer with Roam `{{[[pdf]]}}` support.
- Roam `{{table}}` import, rendering, and editing.

## 2026-07-17 — Image expansion, LaTeX, and page rename/merge

- Uploaded images expand in a modal.
- LaTeX rendering with KaTeX.
- Editable page titles: a rename rewrites references, and renaming onto an existing title merges the pages.

## 2026-07-18 — Linked-reference filters, complete queries, and test data

- Include/exclude filters on linked references.
- Queries return complete results.
- A synthetic dataset for local development.

## 2026-07-19 — CLI/MCP agent access and v1.0.0

- The `pkm` CLI and `pkm-mcp` server give agents read, write, upload, and batch access.
- A `pkm` skill points Claude Code sessions at the CLI.
- Fixed bugs in `/upload` and page-ref autocomplete.
- Tagged **v1.0.0**.

## 2026-07-20 — Bold/italic shortcuts and a shortcut audit

- Cmd-B and Cmd-I toggle bold and italic.
- Letter-chord editing shortcuts use Cmd only, leaving Emacs Ctrl bindings alone.

## 2026-07-21 — Multi-block indentation, tag colour, and v1.0.1

- Tab and Shift-Tab indent and outdent a multi-block selection.
- Fixed tag colour on hover.
- Released [**v1.0.1**](https://github.com/ArthurClune/pkm-system/releases/tag/v1.0.1).

## 2026-07-22 — Sync incident, journal window, keyboard batch, and v1.0.2

- A stuck offline client replayed old edits and moved the whole journal under today's note. Nothing was lost. Stale replays are now blocked, and a stalled sync shows a banner with a reset.
- The journal opens on the last five non-empty days.
- Keyboard batch: select to the block edge, unified block moves, and arrow keys by display line.
- A Link button turns an unlinked mention into a link.
- Architecture docs, a keyboard reference, and an in-app `/help` page.
- Released **v1.0.2**.

## 2026-07-23 — Five-bug fix batch and v1.0.3

- Fixed bugs in page delete on the iPad, Ctrl-O on a new reference, the Link button on bare URLs, search result order, and sync-stall detection.
- Released [**v1.0.3**](https://github.com/ArthurClune/pkm-system/releases/tag/v1.0.3).

## 2026-07-24 — Agent trial of the pkm CLI; assistant scoped

No product change. An agent trial of the CLI found eight gaps, and an in-app assistant was scoped.

## 2026-07-25 — Markdown export, layout width, and an O(n²) parser bug

- Markdown export from a new settings page, per page or as a zip of the whole database.
- Fixed a slow attribute parser that made whole-database export take minutes.
- A wider centre pane when sidebars are hidden, and timestamped server logs.

## 2026-07-26 — CLI improvements, query shortcuts, and the embedded assistant

- CLI gaps from the agent trial closed: exact search, reference expansion, resolved block refs, compact output, and full help.
- `/query-and`, `/query-or`, and `/query-and-not`.
- An in-app "ask my PKM" assistant on the same tools, confirming each write.

## 2026-07-27 — Assistant hardening, journal references, and a reverted paste feature

- The assistant gained a Stop button and a conversation cap, and stops abandoned turns.
- Each journal day shows its linked references.
- Fixed a frequent E2E flake that cleared the outline, and query shortcuts creating pages from their placeholders.
- Outline paste shipped and was reverted the same evening.

## 2026-07-28 — Outline paste rework and image descriptions

- Cmd-V pastes text; Shift-Cmd-V pastes an outline.
- Uploaded images get searchable LLM-written descriptions, backfilled for existing images.
- Assistant answers link to assets and block refs.

## 2026-07-29 — Date shortcuts, the file browser, and control styling

- `/today`, `/tomorrow`, and `/date`.
- The `/files` asset browser, with search, deletion, and zip export.
- Shared control styles and modernised radii, borders, and focus.
- Fixed page titles containing newlines, which made pages unreachable.

## 2026-07-30 — Focus rings, draft-loss fixes, and assistant approvals

- Themed focus rings and capped image width.
- Fixed two ways leaving a block mid-edit saved it empty.
- Assistant write previews list their operations and survive a dropped connection.
- CLI and MCP writes store `## Heading` as a heading.

## 2026-07-31 — Two review sweeps and the high-priority fixes

- Reviews of the server and web code found 46 issues. The fourteen high-priority ones were fixed, covering traversal cycles, empty titles, assistant races, CLI batch atomicity, import integrity, and a fallback when local storage fails.
- Fixed an E2E flake that starved the offline copy of storage under load.

## 2026-08-01 — Both hardening epics finished

- Fixed the remaining 32 review findings, among them login throttling, verified assets, bounded downloads, strict import parsing, a typed web API client, and races in autocomplete and the PDF viewer.

## 2026-08-02 — Web epic follow-ups; title canonicalization built

- Every web API call goes through the typed client, closing epic `pkm-6phf`.
- A migration to canonicalise page titles, built and not yet run.
- Client, CLI, and MCP reads normalise titles as writes do.

## 2026-08-03 — Title integrity migrated; block timestamps

- Titles reject `#`, `[[`, and `]]`, and the title migration ran in production, closing epic `pkm-ulae`.
- Block timestamps in the page margin, tinted by age.
- Collapsing a block no longer changes its edit time, and old Roam blocks got creation times.

## 2026-08-04 — Papercuts, replica availability, and the docs rebuild

- Line-wise Shift-Cmd selection, Shift-click to open in the sidebar, and Ctrl-Shift-T for timestamps.
- Fixed edits stranded in memory when the offline copy could not open. The app now runs online-only with a banner, and one component owns availability, closing epic `pkm-q2jj`.
- Architecture docs rebuilt.

## 2026-08-05 — Docs rebalance and a beforeunload guard

- A warning on closing the tab while edits are held only in memory, on desktop.
- Architecture docs rebalanced.

## 2026-08-06 — Block reference indicator

- A count badge in the block gutter lists the blocks that reference it.

## 2026-08-09 — Outdent takes trailing siblings

- Outdent makes a block's following siblings its children, as Logseq and Workflowy do.

## 2026-08-10 — Bare URLs in unlinked references

- Fixed the Link button when the title appears only inside a bare URL.

## 2026-08-11 — CodeGraph trial

No product change. CodeGraph, a code-search MCP server, was tried and removed.

## 2026-08-12 — Interactive file-browser cards; docs hygiene

- File-browser badges open lists of references and descriptions, and thumbnails expand in place.
- A docs check rejects bean ids in architecture docs.

## 2026-08-13 — Nested code fences minting pages

- Fixed nested code fences closing early and creating pages named after hex colours, and deleted the 27 stray pages.
- A commit hook rejects Claude session URLs.

## 2026-08-14 — z.ai GLM assistant provider; iPad sync dedup

- The assistant can use GLM through the z.ai Coding Plan.
- Fixed duplicate-batch errors on the iPad.

## 2026-08-17 — Paired implementation reviews

No product change. Backend and frontend reviews became a code-quality epic.

## 2026-08-18 — The implementation-quality epic

- Code-quality work from the reviews, closing epic `pkm-wvvu`: single owners for asset checks, reference indexing, and assistant teardown, shared query and batch planning, and no full-tree work per keystroke.
- Page-delete failures are shown, and a rejected batch that cannot be repaired can be discarded.

## 2026-08-19 — Assistant progress and default model

- The assistant shows its progress during long turns and gives up on a silent model.
- The default assistant model is GLM where a z.ai key is configured, and Sonnet otherwise.
- Fixed Escape on an expanded image, and renamed `/bash` to `/shell`.

## 2026-08-20 — Search lands on the matched block

- Search results scroll to and highlight the matched block.

## 2026-08-25 — `/upload` renders its image

- Fixed `/upload` leaving the new image as raw text.

## 2026-08-26 — Mermaid theming and beautiful-mermaid

- Mermaid diagrams use the app's colours and render with beautiful-mermaid, with stock mermaid as a fallback.

## 2026-08-27 — Smaller Bluesky embeds

- Bluesky embeds render at half size on desktop; mobile is unchanged.

## 2026-08-28 — iOS external links; live sidebar block refs

- External links in the installed iOS app open in Safari.
- Fixed block refs typed in the sidebar not resolving.

## 2026-08-29 — PDFs in the file browser

- Fixed PDF cards in the file browser replacing the whole iOS app; they open the in-app viewer.

## 2026-08-31 — Tables in the PKM skill

- The `pkm` skill documents table syntax.

## 2026-09-01 — Sync wedge on degraded networks; performance investigation

- Fixed sync getting stuck on poor networks.
- A frontend performance harness showed reconnects and typing were expensive.

## 2026-09-02 — Frontend performance epic

- Performance work: reconnects back off and refetch only changed views, the journal loads in one request, and typing does a third of the layout work.
- Fixed bugs in offline startup, false "sync is stuck" banners during outages, and PDF rows on the iPad.
- An iPad simulator skill for checks on real iPadOS Safari.

## 2026-09-03 — iPad sync incident, namespace colours, `pkm rename`

- Fixed sync bugs from an iPad rename-merge incident, covering re-created titles, a corrupt search index, endlessly refetched windows, and stale edits re-creating a merged page.
- Page refs coloured by namespace.
- Wrapping a selection in `[[` opens autocomplete.
- `pkm rename` and a matching MCP tool.

## 2026-09-07 — Table of contents; multi-block delete confirm

- `/toc` inserts a table of contents built from the page's headings.
- The multi-block delete confirm appears only for large deletes and says Cmd-Z reverses them.

## 2026-09-09 — `/upload` textarea bug, again

- Fixed `/upload` again after a browser update changed when the block loses focus.

## 2026-09-13 — GPT pages join the AI colour

- `GPT/` page refs share the AI namespace colour.

## 2026-09-15 — Nightly iCloud mirror

- A nightly job mirrors database snapshots and the data directory to iCloud, with a restore command.

## 2026-09-20 — Page-ref headings in the table of contents

- Fixed page-ref headings in the table of contents.

## 2026-09-21 — `Local copy::` links into the iCloud folder

- `Local copy::` lines on paper pages open the PDF from the iCloud folder, and `pkm local check` reports missing or evicted files.
- PDFs on a page load only when opened.

## 2026-09-22 — Self-references out of linked references; architecture docs split

- Fixed a page's own blocks appearing in its linked references.
- The architecture docs became ten shorter files, with past incidents in `docs/troubleshooting.md`.

## 2026-09-23 — GoodLinks copies and labelled Bluesky links

- `Local copy::` can link to a page saved in GoodLinks, readable on the iPad through the server, and `/goodlinks` saves and links a block's URL.
- Labelled Bluesky links render as links; only bare post URLs embed.
- README and deploy docs rewritten in plainer prose.

## 2026-09-24 — GoodLinks follow-ups and note migration

- Migrated 68 free-text GoodLinks notes to `Local copy::` links.
- Fixed GoodLinks bugs with trailing slashes, URLs containing parentheses, and malformed replies.

## 2026-09-25 — `pkm changed` and assistant table guidance

- `pkm changed` lists blocks by edit time, and MCP clients and the assistant get the same listing.
- The assistant writes `{{table}}` blocks into notes.

## 2026-09-26 — Performance regression gate, caret placement, and sync pulls

- A performance gate checks backend and frontend work against committed baselines before merge.
- Each save makes one sync request fewer.
- Fixed the caret jumping back after a slash command, bracket, or autocomplete pick.

## 2026-09-28 — Damaged replica files, conflicts on the daily note, and edits to missing blocks

- Fixed recovery from a damaged offline copy on the iPad, and a block lost when edits reached the server out of order.
- Conflicts land on today's daily note under one header per block, naming its page.
- The server skips edits to a block it no longer has and notes them on the daily note, so they no longer stall later changes.
- The assistant's Opus and Sonnet options use the 5.5 models.

## 2026-09-29 — The sync subsystem review and its fixes

- Fixed sync bugs found by a review of the sync code and by edits clashing on two devices, covering text lost on app suspend, interrupted commits, expired sessions, remote edits during typing, ghost blocks, and stalled queues.
- The offline copy applies batches by the server's rules.
- Sync docs split into design and failure-recovery docs.

## 2026-09-30 — Hash-guarded delete and the sync code extraction

- A delete from a device that missed another device's edit keeps a copy of that edit on the daily note.
- The web sync code split into pure modules, closing epic `pkm-a4t2`.

## 2026-10-01 — Named types, title lookups, and filenames with parentheses

- Ids, titles, hashes, order keys, and other values got distinct types on the server and the web, closing epic `pkm-7uxw`.
- Fixed bugs in title handling, file names containing parentheses, and CLI appends landing mid-list.
- General agent rules moved from Claude's session memory into AGENTS.md and `docs/troubleshooting.md`.

## 2026-10-02 — Property-based sync checks and a clean type check

- Property testing: `proptest/check.sh` checks the server's sync and CLI batch planning against a model written from the docs, and the docs gained the op outcomes they had left unstated.
- The server type check is clean.

## 2026-10-03 — The sync protocol property and five sync fixes

- Property testing extended to the real web sync stack on several devices over a faulty network.
- Fixed five sync bugs it found, in repair after reconnect, conflict dates at midnight, sibling order, catch-up, and replay of acknowledged batches.

## 2026-10-04 — Catch-up fixes and cross-page edits in the sync property

- Property testing draws cross-page moves, renames, and short offline spells.
- Fixed sync bugs in multi-chunk catch-up, cross-page moves, renames racing links, and leftover empty pages.

## 2026-10-05 — Outline and op-divergence properties, replayed edits, and table navigation

- Property testing covers outline edits and agreement between server, offline copy, and editor, closing epic `pkm-nws9`.
- Fixed bugs it found in undo and redo of moves, cursor placement, collapsed blocks, and replayed edits, and fixed `[[[[Link]]]` creating a page.
- Arrow keys stop on the cells of a collapsed table, and a copied table pastes back as a table.

## 2026-10-06 — Cheaper replays, log rotation, and a load-aware performance gate

- Replaying pending edits checks only the rows each batch touched, cutting its work by about 96%.
- The performance gate waits for a quiet machine.
- Production rotates its logs daily, and reinstalling the service waits for the old one to unload.
- Fixed deleted blocks reappearing after a local reset.

## 2026-10-07 — Dropping files onto a page and steadier toc jumps

- Images and PDFs dragged onto a page upload as blocks at the drop point.
- Fixed table-of-contents jumps on long pages.
- Production deploys from the local checkout.

## 2026-10-08 — Undoing an upload deletes its file

- Undoing an upload deletes its file once no block references it.

## 2026-10-10 — Local copy PDFs on the iPad

No product change.

## 2026-10-11 — Local files that fail fast, a stable server launcher, and the iPad simulator under Xcode 27

- Fixed `Local copy::` PDFs hanging the server when macOS blocked file access; they now fail within seconds.
- The server runs through a launcher that keeps its iCloud file permission across upgrades.
- The iPad simulator skill works under Xcode 27.

## 2026-10-12 — Following a link into a collapsed block

- Following a link to a block under a collapsed parent expands the parent and scrolls to the block.

## 2026-10-13 — An iPhone keyboard bar, image placeholders, and missing local files

- An iPhone keyboard bar for indent, outdent, and brackets.
- Images loading over a slow connection show a placeholder.
- Fixed missing `Local copy::` files downloading as JSON, and 45 GoodLinks blocks missing from linked references.

## 2026-10-14 — Page deletes that unlink their references and hold against offline edits

- Deleting a page turns links to it into plain text, is refused when a query or attribute names the page, and holds against older edits from offline devices.
- Fixed two sync bugs that recorded false conflicts or flashed old text.

## 2026-10-15 — Shift-selection tests

No product change.

## 2026-10-16 — Strict typing, comment and line-length lint, and GoodLinks replies

- Strict typing checks on the server and the web.
- A lint for comments citing bean ids or line numbers, and for long lines.
- Fixed GoodLinks replies raising server errors.

## 2026-10-17 — Bluesky embeds in Safari and tighter types

- Fixed Bluesky embeds opening the in-app browser on iOS.
- Tighter types, fixing two unhandled inputs in the CLI and the Roam importer.

## 2026-10-18 — Brand check work in progress

No product change.

## 2026-10-19 — The brand check, checked query columns, and a clean unit run

- A brand check requires every id, title, or hash to carry its type, in tests and tooling as well as the app.
- Offline-copy queries are checked against the columns they name.
- Console warnings fail the web unit run.
- Fixes to the property and performance gates.

## 2026-10-20 — Padded-title fixes, strict models, and a simpler phone layout

- Fixed bugs with padded page titles: edits vanishing from a page opened through a padded link, and duplicate or self-referencing chips in backlink filters.
- The brand check covers titles, telling a title as typed from its stored form, and every server model is strict, so a value of the wrong type is refused.
- The assistant offers the Fable model and knows how to write `Local copy::` links.
- The phone's bottom composer bar is gone, and numbered-list markers sit on the text baseline.

## 2026-10-21 — `/link-local-file`, title and Unicode fixes, and property tests for past bug areas

- `/link-local-file` browses or fuzzy-searches the host's local docs folder and inserts a `Local copy::` link to the chosen file.
- Property testing for areas with a history of bugs: title routes, renames, ref parsing on server and web, uploads, local and GoodLinks links, and hostile input.
- Fixed bugs in title handling, multi-character Unicode, and odd input or stored data that gave server errors.
- A lint requires validation regexes to match the whole string.

## 2026-10-28 — Code-font editing and a browser SQLite update

- A block that is wholly one code fence or one display-math block edits in the code font, so typed columns line up as they render.
- The browser's SQLite updated to 3.54.1, which ships the crash-recovery fix the app had patched in locally.
