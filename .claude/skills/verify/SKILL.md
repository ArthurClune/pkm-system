---
name: verify
description: Build, launch, and drive this app end-to-end to verify a change against the running UI
---

# Verifying pkm end-to-end

The server serves the built SPA from `web/dist`; there is no dev-server path
that avoids the prod proxy footgun (dev vite proxies to 8974 = production on
this machine — never point verification at it).

## Recipe

1. Build the SPA: `cd web && pnpm build`
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
     via `press "Meta+u"`.

## Gotchas

- The headless tab occasionally resets to `about:blank` and drops cookies
  (daemon restart). Just reopen, log in again, and retry — check the server's
  request log to confirm whether the action under test actually fired before
  blaming the app.
- React state updates from synthetic events dispatched inside `eval` are not
  visible in the same eval — re-read the DOM after a short `wait`.
