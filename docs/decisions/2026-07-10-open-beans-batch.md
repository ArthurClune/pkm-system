# Open-beans batch — 2026-07-10

Autonomous run working through all open beans EXCEPT the offline epic
(pkm-y8p0), per Arthur's instruction. Same process as the 2026-07-09
overnight batch: one worktree + branch per bean (`bean/<id>`), Sonnet
subagents implement, main session reviews diffs, merges `--no-ff`, and runs
integrated verification. This file records decisions for later review.

## Scope

- Wave 1 (parallel): pkm-j92y (top menu bar), pkm-x3so (slash-menu bugs),
  pkm-bwvo (create page from search), pkm-ul9u (Ctrl-O opens ref).
- Wave 2 (after pkm-j92y merges — both depend on the top bar):
  pkm-bsjp (minimise sidebar), pkm-ruvz (page deletion).
- Excluded: pkm-y8p0 (offline epic), per instruction.
- **No production deploy.** Everything merges to `main` and is pushed; prod
  untouched (same standing rule as the previous batch).

## Decisions made autonomously

- **pkm-x3so `/text` semantics.** Today `/text` unwraps a whole-fence block
  and is an invisible no-op on ordinary text ("no response"). The bean asks
  for it to *insert a text block*. Chosen: `/text` normalises the block's
  remaining content into a plain fence (```` ``` ````, no language) — an
  unhighlighted multi-line block; on an existing code fence it converts it
  to a plain fence (keeps the content, drops the language). Open question
  flagged for Arthur: plain fences render in monospace; if a
  proportional-font "text block" is wanted, that's a follow-up.
- **pkm-x3so Tab-accept.** Code inspection says Tab already accepts the
  highlighted slash-menu entry (since c0207bf, which predates the bean).
  The agent writes a regression test either way and investigates only if
  it can actually reproduce a failure.
- **pkm-bwvo create endpoint.** `GET /api/page/{title}` 404s for
  nonexistent non-date pages (creation is lazy via block ops), so search
  needs an explicit create: new `POST /api/pages {title}` (idempotent,
  wraps the existing `get_or_create_page`), then the client navigates.
  OpenAPI schema + generated types regenerated.
- **pkm-j92y design.** New `TopBar` component across the top of the main
  pane (desktop and mobile): search button (opens the existing
  SearchModal, Cmd-U unchanged) plus a "…" page menu shown only on
  `/page/*` routes. Initial page-menu action: "Open in sidebar" (real
  action now; Delete arrives with pkm-ruvz). The left-nav Search button is
  removed.
- **pkm-bsjp design.** Collapse toggle lives in the top bar; collapsed
  state persisted in localStorage (same pattern as the theme). Mobile
  hamburger/overlay behaviour unchanged.
- **pkm-ruvz design.** `DELETE /api/page/{title}`: removes the page, its
  blocks, and their outbound refs; inbound `[[links]]` on other pages stay
  as text; sidebar entries pointing at the deleted page are removed.
  Confirmation dialog in the page menu; navigate to `/` afterwards. Other
  live clients pick the deletion up on resync (no WS broadcast for this).
- **Process.** Implementation delegated to Sonnet subagents; main session
  orchestrates, reviews, resolves merge conflicts, runs integrated web +
  server suites, typecheck, build, and Playwright e2e (after `pnpm build`)
  on final main.

## Log

(appended as the run progresses)

- **pkm-j92y merged** (69b1e14). TopBar component with Search button and a
  "…" page menu ("Open in sidebar" for now) on /page/* routes; left-nav
  Search button removed; hamburger left in place; mobile main-pane
  padding-top reduced to the desktop value since the top bar now provides
  the clearance. 303 web tests + typecheck green.
- **pkm-x3so merged** (2fde079). `/text` now normalises the block into a
  lang-less fence (the "text block"); `.code-block` wraps
  (`white-space: pre-wrap; overflow-wrap: anywhere`, `overflow-x: auto`
  dropped). The Tab-accept complaint was NOT reproducible — Tab→pick has
  worked since c0207bf; a regression test now pins it. Click-pick and
  /text insertion tests added.
- **pkm-ul9u merged** (cdc80eb). Pure `refTitleAtCaret` scanner
  (`web/src/outline/refAtCaret.ts`, innermost-span-wins for nested refs)
  + Ctrl-O wiring in BlockInput (only intercepts when the caret is inside
  a closed, non-empty [[ref]]; macOS file-open is Cmd-O so no clash).
- **pkm-bwvo merged** (42924a8). `POST /api/pages` (idempotent, reuses
  get_or_create_page, PageMeta response); OpenAPI artifacts regenerated.
  SearchModal appends `Create page "q"` only once that query's results
  have settled (new resultsQuery gate — no flashing while stale results
  are up); failed POST keeps the modal open. Integrated wave-1 run:
  web suite + typecheck, 286 server tests, pyrefly, ruff — all green.
- **Wave 2 dispatched:** pkm-bsjp (branched after j92y merge) and
  pkm-ruvz (branched after bwvo merge so both OpenAPI regens stack
  instead of conflicting); both agents told to keep TopBar diffs minimal
  since they touch it concurrently.
- **pkm-bsjp merged** (45cd4e4). Collapse toggle at the TopBar's left edge;
  state in localStorage "pkm:sidebar" (theme.ts pattern); phone breakpoint
  overrides `.collapsed` back to flex so the hamburger overlay stays the
  only authority there. Orchestrator follow-up (234eee4): the toggle is
  hidden on phones — it was a visible no-op.
- **pkm-ruvz merged** (59f35b5). `DELETE /api/page/{title}`: explicit
  blocks delete first (so blocks_fts triggers definitely fire), then the
  page row (pages_fts + refs CASCADE), then any sidebar entry; inbound
  [[links]] stay as text. TopBar menu gains "Delete page…" behind
  window.confirm, navigating home on success. TopBar merge conflict with
  bsjp resolved by hand (combined signature + doc comment). Full run
  after merge: 336 web + 292 server tests, pyrefly, ruff, build,
  4/4 Playwright e2e — green; main pushed.
- **Mid-run scope growth.** Another session is committing to this repo
  concurrently (bean adds 3c3e7d9, spec 9ea39cb). Per the goal ("the open
  beans excluding the offline epic") the new arrivals were picked up too:
  - **pkm-7cbq done** (5d1fdfa, orchestrator-implemented): main-pane/
    top-bar left margin = exactly 1/3 of the old centering gap via
    `margin-left: max(0px, calc((100% - 800px)/6))`, unchanged below the
    800px max-width. (Later superseded by pkm-n2kv's card layout.)
  - **pkm-pekk merged** (9149691). ```mermaid fences render via a new
    lazily-loaded MermaidDiagram (module-level cached import promise;
    securityLevel strict; theme picked once at mount from data-theme);
    invalid source degrades to an error note + raw fence. Main bundle
    unchanged; mermaid ships as its own lazy chunk (~634 kB). Full
    verification incl. 4/4 e2e green.
  - **pkm-n2kv NOT taken** (Roam-look restyle). An agent was briefly
    dispatched for it before spotting that another session had already
    claimed it (spec 9ea39cb, implementation plan 9ad933b, branch
    `bean/pkm-n2kv` created in the main checkout); Arthur confirmed it is
    in progress in that other instance, so the agent was stopped with no
    changes made. Left entirely to the other session — including its
    spec's instruction to drop pkm-7cbq's margin calc in favour of the
    card layout.
- **Batch complete.** All open beans except the offline epic (pkm-y8p0)
  and the otherwise-claimed pkm-n2kv are implemented, merged, and pushed:
  pkm-j92y, pkm-x3so, pkm-ul9u, pkm-bwvo, pkm-bsjp, pkm-ruvz, pkm-7cbq,
  pkm-pekk. Final integrated state (at 9149691): 342 web + 292 server
  tests, typecheck, pyrefly, ruff, build, 4/4 Playwright e2e — all green.
  Prod NOT deployed, per the standing rule. All batch worktrees and
  branches cleaned up.
