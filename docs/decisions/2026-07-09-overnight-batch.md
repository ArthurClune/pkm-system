# Overnight batch — 2026-07-09

Autonomous run picking up all open todos/bugs in beans while Arthur sleeps.
pkm-jg1p (block DnD) excluded — in progress in another session on branch
`worktree-dnd-blocks`. This file records decisions made so they can be
reviewed later.

## Decisions from Arthur (asked before starting)

1. **No production deploy overnight.** Everything merges to `main` and is
   pushed; prod is untouched. Arthur reviews and deploys in the morning.
2. **pkm-as55: import the 22 sidebar entries into live data** (direct,
   short-transaction write to `~/.config/pkm/data/pkm.sqlite3`). The UI
   feature only appears in prod after Arthur deploys.
3. **pkm-g356 (editable sidebar panels) runs last**, rebased on whatever has
   merged by then; DnD target/source integration is deferred to a follow-up
   bean if pkm-jg1p hasn't landed.

## Decisions made autonomously

- **Sequencing / clash avoidance.** Each bean gets its own worktree + branch
  (`bean/<id>-<slug>`), merged into `main` sequentially with `--no-ff`.
  - Wave 1 (parallel): pkm-r1wy (deploy guard), pkm-bz6n (shortcuts),
    pkm-as55 (sidebar entries), pkm-j5n6 (slash commands). Mostly disjoint
    files; App.tsx/styles.css overlaps resolved at merge time.
  - Wave 2: pkm-pthk (dark mode) — after wave 1 so the CSS-variable refactor
    covers all new CSS in one pass.
  - Wave 3: pkm-g356 — last, to minimise conflict surface with pkm-jg1p.
- **pkm-as55 design:** there is no persistent sidebar-entries storage today
  (the shift-click stack is in-memory React state). Chosen design: new
  SQLite table + `GET /api/sidebar` endpoint + a left nav sidebar rendering
  the entries as page links, plus an idempotent import script (modelled on
  `pkm.importer`) run once against live data. Managing entries from the UI
  is a follow-up bean. Pages are not pre-created; links create pages on
  first visit as usual.
- **pkm-r1wy design:** `update.sh` refuses to run (loud error, exit 1) when
  the checkout it lives in is not `$PKM_HOME/app`, overridable with
  `PKM_UPDATE_FORCE=1` for dev use. Chosen over "delegate to deployed copy"
  as the simpler, more explicit option. Plus `Cache-Control: no-cache` on
  the SPA index.html response in `app.py`.
- **pkm-pthk design:** refactor `styles.css` to CSS custom properties;
  three-way theme control (system / light / dark) persisted in
  localStorage, defaulting to system (`prefers-color-scheme`); highlight.js
  gets a matching dark theme.
- **pkm-j5n6 scope:** slash menu reuses the existing autocomplete machinery
  (`outline/autocomplete.ts` + `AutocompletePopup`). Initial commands are
  text-edit-based: `/text`, `/python`, `/bash`, `/javascript` (markdown
  fences), `/todo`. Heading commands only if an existing op supports them;
  otherwise deferred and noted on the bean.
- **Process:** implementation delegated to Sonnet subagents (per standing
  preference); main session orchestrates, reviews diffs, resolves merge
  conflicts, and runs integration tests. Unit tests + typecheck run per
  branch; Playwright e2e runs once per merge on `main` (single port, can't
  run in parallel).

## Log

(appended as the run progresses)
- **pkm-r1wy merged** (d4a265b). Guard verified safely with stubbed
  git/uv/pnpm/launchctl — no real prod command was executed during testing.
  190 backend tests pass.
- **pkm-bz6n merged.** Search moved Cmd-K → Cmd/Ctrl-U (Cmd-K removed);
  Ctrl-Cmd-D navigates home. No input-focus guard added — matches the
  pre-existing unguarded Cmd-K behaviour. 161 web tests + typecheck pass.
- **pkm-j5n6 merged.** Slash menu ships /text, /todo, /python, /bash,
  /javascript, reusing the existing autocomplete machinery. Bare "/" opens
  the menu; slashes glued to text (URLs, paths) never trigger. /h1-3
  deferred to new bean pkm-kiip — there is no writable op path for
  `heading` on existing blocks and we chose not to add a server op in this
  batch. 174 web tests + typecheck pass.
- **pkm-as55 merged.** New `sidebar_entries` table; no migration runner
  exists in this project, so the DDL is `CREATE TABLE IF NOT EXISTS` re-run
  on every `open_db()` — existing/prod DBs pick it up automatically.
  `GET /api/sidebar` + left-nav list UI (read-only; management UI is new
  bean pkm-4wbu). The 22 entries were imported into the LIVE database
  (pre-approved): tested on a backup-API copy first, then run for real —
  inserted 22/22 in order, re-run confirmed idempotent (0 inserted), page
  and block counts unchanged, server process untouched. Wave 1 integrated
  suites: 181 web + 201 server tests + typecheck all green.
- **pkm-pthk merged.** styles.css refactored to CSS custom properties
  (light palette pixel-identical); dark palette applied via
  `@media (prefers-color-scheme: dark)` + `data-theme` override, toggle
  cycles system→light→dark, persisted at localStorage "pkm:theme".
  highlight.js theme colors inlined into styles.css as --hljs-* vars (Vite
  CSS imports are global, so the two-import approach can't switch).
  Anti-flash inline script in index.html for explicit light/dark only.
  Note: test-setup.ts now stubs matchMedia and localStorage per-test —
  Node 26's experimental localStorage global shadows jsdom's and returns
  undefined. 191 web tests + typecheck + build green.
- **pkm-g356 dispatched with conflict-containment constraints.** Observed
  that the jg1p session's branch now touches SidebarPanel.tsx directly
  ("sidebar panels as drag-and-drop sources and targets"). Proceeding per
  Arthur's pre-approval, but the agent must keep SidebarPanel.tsx as a thin
  wrapper delegating to a new EditableSidebarPanel file and avoid
  restructuring useOutline.ts, so the jg1p merge stays tractable. DnD
  integration of editable panels goes to a follow-up bean.
- **pkm-g356 merged — all six original beans complete.** Panels are now
  editable outlines via a new EditableSidebarPanel; SidebarPanel is a thin
  wrapper (-22/+2) and useOutline is untouched, per the conflict-containment
  constraint. Real hazard found and fixed: two live editors of the same
  page in one tab would silently diverge (WS echo filter is per client_id,
  per tab), so an activeOutlines refcount registry makes the first mount
  editable and later mounts read-only-but-live. DnD integration deferred to
  pkm-auvy (blocked by pkm-jg1p). Final integrated run: 203 web + 201
  server tests, typecheck, build, and both Playwright e2e scenarios green.
- **Scope extension (autonomous):** the run spawned three follow-up beans;
  two are unblocked and within the "all todos and bugs" goal, so they are
  being implemented next, sequenced because both regenerate OpenAPI types:
  pkm-kiip (heading slash commands, needs a SetHeading op) then pkm-4wbu
  (sidebar entry management UI). pkm-auvy remains blocked by pkm-jg1p.
- **pkm-kiip merged.** New SetHeadingOp (modelled on SetCollapsedOp),
  OpenAPI regenerated; /h1 /h2 /h3 with toggle-off plus /normal; slash
  regex now allows digits after a leading letter. Note: ops_core.py will
  need a small conflict resolution when pkm-jg1p merges (both touch the
  op union).
- **pkm-4wbu merged — batch complete.** POST/DELETE/PUT /api/sidebar with
  pure permutation validation; quiet "Edit" toggle in the nav reveals
  add/remove/↑↓ controls, refetch-after-write, dark-safe via existing CSS
  vars. Flagged (not fixed): duplicate detection is exact-match on trimmed
  title — case variants would be accepted as distinct.
- **Final state:** 8 beans completed and merged (pkm-r1wy, pkm-bz6n,
  pkm-j5n6, pkm-as55, pkm-pthk, pkm-g356, pkm-kiip, pkm-4wbu). Remaining:
  pkm-jg1p (other session, in progress) and pkm-auvy (blocked by jg1p).
  Full verification on final main: 225 web + 224 server tests, typecheck,
  build, 2/2 Playwright e2e — all green. Prod NOT deployed, per decision;
  run ~/.config/pkm/app/deploy/update.sh to ship (the new guard will now
  refuse the dev-checkout footgun). All worktrees cleaned up.
