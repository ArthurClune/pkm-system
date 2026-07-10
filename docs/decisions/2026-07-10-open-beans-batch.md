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
