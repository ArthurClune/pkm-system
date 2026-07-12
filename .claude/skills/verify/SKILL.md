---
name: verify
description: Build, launch, and drive this app end-to-end to verify a change against the running UI
---

# Verifying pkm end-to-end

The server serves the built SPA from `web/dist`; there is no dev-server path
that avoids the prod proxy footgun (dev vite proxies to 8974 = production on
this machine — never point verification at it).

## Recipe

1. Build the SPA — **only if your diff touches `web/`** (check:
   `git diff --name-only main | grep '^web/'`): `cd web && pnpm build`.
   For server-only changes, skip the build: the server serves `web/dist` as
   static files and runs Python from source, so an existing dist built on this
   branch is already current. Rebuilding "to be safe" is never needed — a
   stale dist is only possible if `web/` changed since the last build.
2. Scratch server config (data dir anywhere disposable):

   ```bash
   cd server
   uv run python -m pkm.server.setup --data-dir "$SCRATCH" \
     --password testpw --insecure-cookie --web-dist ../web/dist
   ```

   `--web-dist` is resolved **relative to the data dir**; when the data dir is
   outside the repo, patch `config.json` afterwards to set `web_dist` to the
   absolute path of `web/dist` (pathlib joins absolute paths correctly).
3. Run on a scratch port (NOT 8974 — prod launchd service owns it):

   ```bash
   uv run python -m pkm.server.run --data-dir "$SCRATCH" --port 8975 --host 127.0.0.1
   ```

4. Drive with agent-browser (`--session <name>` to isolate):
   - `/login` page → fill password `testpw`, click "log in".
   - The DB starts empty: click a journal day's "Click to start writing…" to
     create blocks; typed text flushes to the server after ~500 ms debounce.
   - Block editing happens in a bare `<textarea>`; `press "Meta+a"` does NOT
     select-all in headless CDP — position the caret with
     `eval 'el.setSelectionRange(...)'` or repeated Backspace instead.
   - App shortcuts implemented as JS listeners (e.g. Cmd-U for search) DO fire
     via `press "Meta+u"`. Cmd-U is a toggle: it focuses the always-present
     top-bar search input (there is no search modal); pressed again it
     cancels and clears the query.

## Known selectors

Verified against the live app (2026-07-12). Drive the app with these —
they make discovery snapshots unnecessary for all routine checks.

| Surface | Element | Selector |
|---|---|---|
| Login | password input | `#pw` |
| Login | submit button | `form button` |
| Shell | sidebar container | `nav.left-nav` |
| Shell | sidebar toggle | `button.sidebar-toggle-button` |
| Journal | empty-day placeholder | `button.empty-page` |
| Journal | block editor (while editing) | `textarea.block-input` |
| Journal | rendered block | `div.block-text` |
| Journal | day section / block row | `section.journal-day` / `div.block-row` |
| Search | top-bar wrapper | `div.top-bar-search` |
| Search | input | `input.top-bar-search-input` |
| Search | results list | `ul.search-results` |
| Search | result row | `li.search-result` (+ `.selected` on the active row) |

- No `data-testid` attributes exist anywhere; these class names are literal
  in `web/src` (not generated), so they're stable until someone renames them.
- A `li.search-result` row may be the synthetic `Create page "…"` row, not a
  hit; match highlighting is a `<mark>` inside `span.result-snippet`.
- To blur a block editor (turn `textarea.block-input` into `div.block-text`),
  focus another input — clicking static content doesn't reliably blur in
  headless CDP.
- If a selector here fails, the UI changed: re-derive it with a scoped
  `snapshot -s <parent>` and update this table in the same commit.

## Batch sessions: reuse, don't tear down

When verifying several changes in one session, steps 2–3 run **once**; each
subsequent check is reload-and-drive against the same environment:

- Keep the scratch server and the agent-browser session alive between checks.
  After a rebuild, a page reload picks up the new bundle — the server reads
  `web/dist` from disk per request, no restart needed.
- Content created by earlier checks is an asset (search/autolink tests need
  something to find), not pollution. Recreate the data dir only when a change
  touches DB schema/migrations or the test specifically needs an empty DB.
- Kill the server and remove `$SCRATCH` once at the end of the batch.

## Reading results

- Drive and assert with the known selectors above: `fill`/`click`/`press`
  to act, `get text <sel>`, `is visible <sel>`, or
  `eval 'document.querySelector("<sel>")?.innerText'` to check. Routine
  checks need no snapshot at all.
- `snapshot` is for discovering UI the selector table doesn't cover (a new
  surface, an unexpected state). Scope it: `snapshot -s <sel>` for one
  subtree, or `-i -c` (interactive-only, compact) for page-level orientation.
  A bare full-page `snapshot` is a last resort, not a first look.
- `screenshot` is for visual assertions — layout, styling, drag affordances —
  where the pixels ARE the thing under test. One screenshot at the final
  verified state usually suffices; don't screenshot intermediate steps that a
  DOM read already confirms.

## Gotchas

- The headless tab occasionally resets to `about:blank` and drops cookies
  (daemon restart). Just reopen, log in again, and retry — check the server's
  request log to confirm whether the action under test actually fired before
  blaming the app.
- React state updates from synthetic events dispatched inside `eval` are not
  visible in the same eval — re-read the DOM after a short `wait`.
