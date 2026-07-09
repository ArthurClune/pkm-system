---
# pkm-r1wy
title: update.sh silently updates whatever checkout it lives in
status: completed
type: bug
priority: normal
created_at: 2026-07-09T19:46:33Z
updated_at: 2026-07-09T21:21:14Z
---

Running deploy/update.sh from the dev checkout pulls/rebuilds the dev repo but kickstarts the production service — the deployed app at $PKM_HOME/app is untouched, so "updates" silently do nothing in prod (bit us on pkm-862c). Options: make update.sh refuse to run (or warn loudly) when its APP dir is not $PKM_HOME/app, or make the dev copy delegate to the deployed one. Also worth adding while in there: serve index.html with cache-control: no-cache so browsers revalidate and pick up new hashed bundles immediately after deploys.

## Summary of Changes

- `deploy/update.sh`: resolve `APP` and the expected deployed path (`$PKM_HOME/app`, `PKM_HOME` defaulting to `$HOME/.config/pkm`) both via `pwd -P` (symlink-resolved) and refuse to run with a clear stderr message + exit 1 if they don't match. `PKM_UPDATE_FORCE=1` bypasses the guard for intentional dev use. The refusal happens before any `git`/`uv`/`pnpm`/`launchctl` calls, so it's side-effect-free.
- `server/src/pkm/server/app.py`: the SPA catch-all (`spa()`) now returns `FileResponse(index_html, headers={"Cache-Control": "no-cache"})` so browsers revalidate index.html and pick up new hashed bundle references after a deploy. Hashed assets under `/app-assets` are untouched (still served via `StaticFiles`, cacheable).
- `server/tests/test_spa.py`: added `test_index_html_is_not_cached`, asserting `Cache-Control: no-cache` on `/` and on a client-side deep route, and that `/app-assets/main.js` is *not* marked `no-cache`. Written first, confirmed it failed (`KeyError: 'cache-control'`), then the fix made it pass.

### Verification
- `cd server && uv run pytest` — 190 passed.
- Guard manually exercised three ways (all safe — refusal path never runs downstream commands; pass/force paths were run with `git`/`uv`/`pnpm`/`launchctl` stubbed to no-ops so nothing hit real prod):
  - Default `PKM_HOME`, run from this worktree → refuses, exit 1, message names the expected deployed path (`.../.config/pkm/app`).
  - `PKM_HOME` pointed at a symlink to this worktree (so resolved paths match) → guard passes, proceeds through git/uv/pnpm/launchctl (stubbed).
  - `PKM_UPDATE_FORCE=1` with default (mismatched) `PKM_HOME` → guard bypassed, proceeds through git/uv/pnpm/launchctl (stubbed).

### Deferred
- Did not touch the "dev copy delegates to deployed one" alternative mentioned in the original bean description — the refuse-and-exit approach was the agreed design.
