# Handover: plan 6 spec + plan written → execute

Written 2026-07-09, after brainstorming and plan-writing for plan 6.
Audience: the session that will EXECUTE the plan via
superpowers:subagent-driven-development. Supersedes
`2026-07-09-plan6-handover.md` for "what next" (that doc's deployment
facts and process lessons still apply — read it too).

## Where things stand

- **main is at `44fa4c6`, pushed.** Two new commits on top of the plan-5
  merge: the spec (`69ba320`) and the implementation plan (`44fa4c6`).
- **Spec (user-approved):**
  `docs/superpowers/specs/2026-07-09-plan6-deployment-design.md`
- **Plan (self-reviewed, not yet executed):**
  `docs/superpowers/plans/2026-07-09-plan6-deployment.md` — 13 tasks,
  TDD steps with full code.
- No implementation code exists yet; no worktree created yet.

## What to do

1. `superpowers:using-git-worktrees` → new worktree/branch for plan 6.
2. `superpowers:subagent-driven-development` for **Tasks 1–12 only**,
   per-task review gates as in plans 1–5.
3. **Task 13 is CONTROLLER-ONLY**: it migrates the live graph to
   `~/.config/pkm`, installs launchd services, and runs smoke + backup
   verification on the real machine. It runs in the main session, after
   Tasks 1–12 are merged to main (`--no-ff`) and pushed. Never hand it
   to a subagent.

## Decisions made in brainstorming (user-confirmed, don't re-litigate)

- **This machine ("biber", macOS 26.5.2, Tailscale 1.98.5) IS the Mac
  mini target** — install and verify live in-session (Task 13).
- Service home **`~/.config/pkm/{app,data,backups,logs}`**; prod runs
  from a dedicated clone (`app/`), never the dev checkout. Test servers
  always use separate scratch graphs.
- **Dual exposure**: Tailscale Serve HTTPS for browsers AND a direct
  bind on the machine's Tailscale IP (100.104.x.y:8974) for tailnet API
  clients. `cookie_secure` stays true. 100.104.x.y is the *tailnet* IP
  (`tailscale ip -4`), not a public address.
- Backups **local-only**, one sync-friendly `backups/` dir; git history
  for exported markdown only, assets mirrored but gitignored (user: "a
  clean export dir including sqlite and files that I can sync elsewhere").
- **Upload cap default 150 MB** — measured against the live graph: 6
  assets over 25 MB, largest 96.7 MB (PDFs). Don't lower it.
- All deploy files repo-committed as templates (`{{USER}}`, `{{UV}}`,
  `{{PKM_HOME}}`), zero secrets/usernames/paths — **repo may go public**.
  Task 12 Step 7 has a leak-grep; take it seriously.
- All four carry-forward fixes in scope: upload hardening,
  visibilitychange flush, doomed update_text guard, SyncContext loud
  default. SVG never serves inline.

## Gotchas already caught while writing the plan (kept in the plan text)

- Smoke script cookie extraction: the session cookie is HttpOnly, so
  curl's jar prefixes its line with `#HttpOnly_` — a naive `!/^#/` awk
  drops it. The plan's awk handles both forms.
- `websockets` kwarg is `additional_headers` on >=14 but
  `extra_headers` on 13.x — Task 12 says to check the installed version.
- Task 2 Step 5 is a mandatory live check that `uvicorn.Server.run(sockets=...)`
  actually serves in this repo; if it doesn't, STOP and re-plan (no
  silent workarounds).
- `tests.conftest` is not importable as a module — the new upload tests
  define `TEST_PASSWORD = "test-pw"` locally (must match conftest).

## Verification commands (unchanged from plan 5)

- server: `cd server && uv run pytest -q`
- web: `cd web && pnpm typecheck && pnpm test -- --run`
- e2e: `cd web && pnpm e2e` (own scratch server on :8975)

## Process reminders (bitten before)

- **Shared task list:** subagents can see and self-claim session tasks.
  Don't pre-create pending plan tasks while dispatching; put "do NOT
  claim, create, or update tasks in the session task list" in every
  dispatch prompt (it's also in the plan's Global Constraints).
- Idle background reviewers: ping via SendMessage to resend their
  report; don't re-dispatch.
- Live data: `/Users/arthur/code/llm/pkm/data/` (4314 pages / 52695
  blocks) and later `~/.config/pkm/` are off-limits to Tasks 1–12 and
  to every subagent; tests use tmp_path only. Never open the live DB
  for writing — read-only URI (`mode=ro`) for any inspection.
- CLAUDE.md: always push after committing (from the main checkout;
  worktree branches push when merged); merge with `--no-ff`.
