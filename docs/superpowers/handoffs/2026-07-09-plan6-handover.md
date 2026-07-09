# Handover: plans 1–5 done → plan 6 (deployment)

Written 2026-07-09 after merging plan 5. Audience: the session that will
brainstorm and write plan 6. Everything here is either state you can trust
or context you'd otherwise have to re-derive.

## Where the project stands

- **Sequence:** import ✅ → read API ✅ → write path/sync ✅ → frontend
  read ✅ → frontend edit ✅ → **deployment (plan 6, unwritten)**.
- **main is at `a4ce0ad`** (plan-5 merge, `--no-ff`), pushed. Suites at
  that commit: server 158 passed, web 154 passed + strict typecheck,
  Playwright e2e 2/2 in real Chromium.
- The app is feature-complete for personal use: block-outline editing with
  optimistic ops through the single write path `POST /api/ops`, live
  two-client WebSocket sync, pause-on-disconnect (banner + every write
  affordance disabled), `[[`/`#` autocomplete, image paste/drop + phone
  composer, TODO/collapse persistence.
- **Real data:** the live graph lives in the MAIN checkout at
  `data/pkm.sqlite3` (4314 pages / 52695 blocks as of 2026-07-09) with
  assets in `data/assets/`. `data/` is never committed. A full smoke
  against a scratch copy of this graph passed on 2026-07-09 — findings in
  the spec ("Frontend-edit smoke findings (plan 5)"). Performance headroom
  is large (692-block page edits produce zero long tasks); no
  virtualization needed.

## What plan 6 is

Spec Section 5 ("Deployment, backup, testing") in
`docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md`:

- launchd service on the Mac mini; app binds `127.0.0.1` only; exposed via
  **Tailscale Serve** (HTTPS termination, tailnet-only — also gives Safari
  the secure origin its clipboard APIs need).
- **Nightly backups** (launchd jobs): rotating SQLite online backup, plus a
  full markdown + assets export into a git-committed directory.

## Deployment facts already learned (save yourself the archaeology)

- **Server entrypoint:** `cd server && uv run python -m pkm.server.run
  --data-dir ../data --port 8974` (defaults shown). It loads
  `<data-dir>/config.json`.
- **config.json format** (paths resolve relative to the config file's
  directory): `db_file`, `assets_dir`, `password_salt` (hex),
  `password_hash` (hex scrypt — `pkm.server.auth_core.hash_password`),
  `session_secret` (hex), `cookie_secure` (default true — correct behind
  Tailscale Serve HTTPS), `web_dist` (built SPA dir, e.g. `../../web/dist`;
  omit for API-only). Working reference: `server/tests/e2e_serve.py`.
- **`websockets>=13` is a required server dep** (already in
  `server/pyproject.toml`): plain uvicorn ships no WS protocol library, so
  `/api/ws` upgrades fail on a real server without it even though all
  TestClient suites pass. Found in plan 5; verified working with real
  uvicorn. Any deployment smoke should include a real WS connection.
- **SPA build:** `cd web && pnpm build` → `web/dist` (~363KB js). The
  server serves it when `web_dist` is set.
- Assets are session-auth-gated (cookie-less request → 401) and stored
  sharded by content hash (uploads deduplicate naturally).
- The SQLite online-backup API pattern for the nightly job is already
  proven in plan 5's smoke (open source with `mode=ro` URI, `src.backup(dst)`).

## Carry-forwards plan 6 must triage

Durable list: spec sections "Frontend-edit carry-forwards (plan 5 final
review)" and earlier carry-forward sections. Highlights: **asset upload
size cap + mime allowlist / `Content-Disposition` + `nosniff`** (the one
explicitly deferred TO deployment); `visibilitychange` draft flush (cheap,
closes the only real data-loss window); click-to-focus caret mapping;
snapshot backlinks while editing; journal scroll reset on resync;
split-then-type remount race (automation-speed only).

Final-review Minors recorded as accepted but NOT in the spec (the per-task
ledger died with the plan-5 worktree, so they live here):

- `useOutline.takePendingTextOps` flushes a doomed `update_text` for a
  block a remote batch just deleted → whole batch rejected → desync
  refetch. Self-healing; one-line guard (return `[]` when node gone).
- `SyncContext` default silently no-ops `enqueue` — a component mounted
  outside the provider drops writes without a trace; a throwing/logging
  default would fail loud.
- Duplicated autocomplete keyboard wiring (`EditableBlockTree.tsx` vs
  `Composer.tsx`) — extract a `useAutocompleteField` hook if a third
  consumer appears.
- `server/tests/e2e_serve.py` leaks its `mkdtemp` dir per run;
  `playwright.config.ts` hardcodes `reuseExistingServer: true` — both fine
  locally, revisit if CI is added.
- T1 ws broadcast is sequential (N×SEND_TIMEOUT worst case) — plan-mandated,
  fine at one-user scale.

## Process notes for the next controller

- Workflow that worked: brainstorming → writing-plans → git worktree →
  superpowers:subagent-driven-development with per-task review gates → final
  whole-branch review (most capable model) → one fix wave → merge `--no-ff`.
  The gates caught real bugs every time they ran (href-allowlist XSS bypass,
  op-queue invariant bugs, three separate paused-writes gaps).
- **The session task list is shared with spawned subagents.** An idle
  general-purpose agent once self-claimed pending plan tasks and executed
  them without review. Either don't pre-create pending plan tasks while
  dispatching, or put "do NOT claim, create, or update tasks in the session
  task list" in every dispatch prompt. (Also saved as a persistent memory.)
- Background review agents sometimes go idle without delivering their
  report — ping them via SendMessage and ask them to resend; don't
  re-dispatch.
- Real-data smokes: copy the DB with the sqlite backup API from a `mode=ro`
  source connection, run on a scratch `--data-dir`, and prove pre/post
  counts + mtime unchanged on the real file. Never open the live DB for
  writing.
- Commands: server `cd server && uv run pytest -q`; web `cd web && pnpm
  typecheck && pnpm test -- --run`; e2e `cd web && pnpm e2e` (boots its own
  scratch server on :8975).
