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
