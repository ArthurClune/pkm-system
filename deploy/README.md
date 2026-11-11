# Deploying PKM

These scripts run the server, the nightly backup and the nightly iCloud mirror
as launchd services on a Mac, behind Tailscale Serve for HTTPS access from other devices
on the tailnet.

## Layout

Everything lives under `$PKM_HOME` (default `~/.config/pkm`):

```
~/.config/pkm/
  bin/        pkm-server, the launcher binary (built by install.sh)
  app/        git clone of the local dev checkout (made by install.sh)
  data/       config.json, pkm.sqlite3, assets/ — the live database
  backups/    nightly sqlite snapshots + markdown/asset export
  logs/       server.log, access.log (+ 30 dated copies of each),
              server.{out,err}.log, backup.{out,err}.log,
              icloud-backup.{out,err}.log
```

The server writes `server.log` (lifecycle, errors, `pkm.*` loggers) and
`access.log` (one line per request, with its duration) itself, because the
plist passes `--log-dir`. Both rotate at midnight and keep 30 days
([Troubleshooting](#troubleshooting) says where each log is). The backup
jobs' logs grow by a few KB a month and are not rotated.

`install.sh` and `update.sh` only create `data/`; they never modify an
existing `config.json` or database.

## First install

1. Run `deploy/install.sh` from any checkout of this repo or its worktrees.
   If `$PKM_HOME/app` doesn't exist, it clones the main checkout there, so the
   clone's `origin` is that local path. It builds the launcher into
   `$PKM_HOME/bin/pkm-server` if missing, runs `uv sync` so the venv exists,
   and renders the three launchd
   plists from the templates in this directory, loads them with
   `launchctl bootstrap`, and configures Tailscale Serve to forward HTTPS on
   the tailnet to the local server port.
   Serve must proxy to `http://127.0.0.1:<port>`.
   Pointed at the Tailscale IP, every Serve client shares one login-backoff
   bucket unless `run.FORWARDED_ALLOW_IPS` changes with it.
   Pointed at `[::1]` (or a `localhost` resolving to it), it reaches nothing,
   because the server listens on IPv4 only
   ([request-boundary.md § Login throttle](../docs/architecture/request-boundary.md#login-throttle)).
2. Build the web app (required before first startup):
   ```bash
   cd "$PKM_HOME/app/web" && pnpm install --frozen-lockfile && pnpm build
   ```
3. If `$PKM_HOME/data/config.json` doesn't exist yet, create it:
   ```
   cd "$PKM_HOME/app/server" && uv run python -m pkm.server.setup \
     --data-dir "$PKM_HOME/data" --web-dist ../app/web/dist
   ```
   This prompts for the app password and writes `config.json` (mode 0600)
   with the password hash, session secret, and `web_dist`.
4. Add the `bind_hosts` and `serve_origins` lines that `install.sh` printed
   (loopback plus your Tailscale IP; your Serve hostname) to `config.json`
   by hand. `setup.py` knows neither:
   ```json
   "bind_hosts": ["127.0.0.1", "100.x.y.z"],
   "serve_origins": ["https://<machine>.<tailnet>.ts.net"],
   ```
   Without `serve_origins` the server refuses every write and live-update
   connection from the Serve hostname as a foreign origin
   ([request-boundary.md § Auth](../docs/architecture/request-boundary.md#auth)).
5. Restart the server so it picks up the new config:
   `launchctl kickstart -k "gui/$UID/com.$USER.pkm.server"`.
6. After the first start, open a Local copy file (or run `pkm local check`)
   and click **Allow** for "pkm-server" at the Mac's screen.
7. Run `deploy/smoke.sh` to verify the install end-to-end.

## Updating

Run `$PKM_HOME/app/deploy/update.sh`. It refuses to run from any other
checkout (set `PKM_UPDATE_FORCE=1` to override), because it would rebuild
that checkout while restarting the prod service. It leaves the backup jobs
alone.

| Step | What it does |
|---|---|
| Fetch | `git fetch <source> main`, then `git merge --ff-only FETCH_HEAD` |
| Server | `uv sync` |
| Web | `pnpm install --frozen-lockfile && pnpm build` |
| Restart | `launchctl kickstart -k` the server service |

The source is `PKM_SRC` if set, otherwise the app checkout's `origin`. It must
be a local directory: a deploy ships committed `main` of the dev checkout,
with no push to GitHub. If `origin` is a URL, `update.sh` refuses to run.
Repoint it with `git -C "$PKM_HOME/app" remote set-url origin <dev checkout>`.
If the app checkout has diverged from `main`, the fast-forward fails and
nothing is rebuilt.

Run it as `CI=true $PKM_HOME/app/deploy/update.sh` when there is no terminal:
without it pnpm aborts asking to purge `node_modules`.

Verify the deploy rather than trusting the "updated to <sha>" line.
`launchctl kickstart` silently does nothing when the service is unloaded, so
check `launchctl list | grep pkm` and which process owns the production port
(`lsof -nP -iTCP:8974 -sTCP:LISTEN`), then grep the served bundle (under
`/app-assets/`) for a string the change added.

`update.sh` does not re-render the launchd plists. When an update changes a
`*.plist.template`, run `$PKM_HOME/app/deploy/install.sh` after it, which
re-renders and reloads every job.

## The launcher

The server job runs `$PKM_HOME/bin/pkm-server <venv python> -m pkm.server.run
...` (source: `deploy/launcher/pkm-server.swift`, built and ad-hoc signed by
`deploy/launcher/build.sh`). macOS grants iCloud file access to the launchd
job's own binary, not to the Python it starts. The launcher stays the
server's parent and forwards its signals, so the grant attaches to it. The
grant is keyed to the binary's path and code hash, so it survives `uv`,
Homebrew, Python and app upgrades, and a rebuild of unchanged source with the
same toolchain. A source change, a Swift toolchain change or a moved
`PKM_HOME` gives a new client, and the consent prompt returns at the Mac's
screen.
`update.sh` never rebuilds the launcher: a change under `deploy/launcher/`
reaches prod only through `install.sh --rebuild-launcher` followed by Allow.
`install.sh` records the built source's SHA-256 in
`$PKM_HOME/bin/pkm-server.source-sha256`, and `update.sh` warns when the
deployed source no longer matches it.
To re-grant, click Allow on the prompt, or use System Settings → Privacy &
Security → Files and Folders → pkm-server → iCloud Drive.

## Backups

The nightly `pkm.backup` launchd job (03:30) writes to `$PKM_HOME/backups/`:

- `sqlite/`: one `pkm-YYYY-MM-DD.sqlite3` snapshot per night, taken from a
  read-only connection. Rotation keeps the newest 14 daily snapshots plus
  the latest snapshot of every calendar month.
- `export/`: a markdown + assets export of the same snapshot, committed to a
  local git repo each night. Assets are kept on disk but not committed.

`backups/` is the directory to copy off the machine (rsync, Time Machine,
cloud sync). `app/` is reproducible and `data/` can be rebuilt from
`backups/`.

### Off-machine copy: iCloud Drive

The `pkm.icloud-backup` launchd job (`deploy/icloud_backup.py`, system
python, stdlib only) runs at 04:30 and mirrors into
`~/Library/Mobile Documents/com~apple~CloudDocs/pkm backups/`:

| Path | Contents | Retention |
|---|---|---|
| `db/pkm-YYYY-MM-DD.sqlite3` | the nightly sqlite snapshots | newest 30 days |
| `data/main/` | plain copy of `data/` as of `data/main.manifest.json` | rolls forward, see below |
| `data/incr/YYYY-MM-DD/` | `files/` added or changed since the previous snapshot, `deleted.txt`, and a full `manifest.json` | newest 30 days |

`data/` on day T is `main` with every `incr/` up to T applied in date order.
Once `main` is older than 30 days, the oldest incremental is folded into it,
so the oldest restorable point stays about 30 days back. The data mirror
leaves out the live `pkm.sqlite3` and its `-wal`/`-shm` files, since a copy
taken while the server runs is not a consistent snapshot; `db/` covers the
database.

The mirrored `config.json` has its `session_secret` removed, and any other
file whose bytes contain the secret (a copy, a hard link, either hex case) is
skipped. If `config.json` cannot be read or parsed as a JSON object it is not
mirrored (the previous mirrored copy stays in the snapshot). Any of these
makes the run print `PARTIAL`, say why on stderr and exit 1; the rest of the
backup is still taken. A skipped file keeps the run failing each night until
it is deleted or the secret is rotated.

Restore the data dir as of a date into an empty folder. The matching
`db/pkm-YYYY-MM-DD.sqlite3` goes into it through `pkm.backup.restore`, run
on `$PKM_HOME/app/server/.venv/bin/python` (`--pkm-python` picks another),
so it gets a new `db_generation` like any [restore](#restore):

```bash
"$PKM_HOME/app/deploy/icloud_backup.py" restore \
  --dest "$HOME/Library/Mobile Documents/com~apple~CloudDocs/pkm backups" \
  --date 2026-09-01 --out /tmp/pkm-restore
```

With no snapshot for that date, it says so and leaves the database out:
restore the nearest one into the folder as in [Restore](#restore), with
`--data-dir /tmp/pkm-restore`. To make the folder live, stop the server,
move it into place as `$PKM_HOME/data`, and start the server.

The restore checks the result against that day's manifest and fails on any
mismatch. If iCloud has evicted files ("Optimize Mac Storage"), the restore
and the nightly fold ask `brctl` to download them and wait. A file that never
arrives aborts the run, and the next night retries.

The restored `config.json` gets a fresh `session_secret` (mode `0600`), so
every device logs in once more.

## Restore

1. Stop the server: `launchctl bootout "gui/$UID/com.$USER.pkm.server"`.
2. Put the dated snapshot in place:
   ```bash
   cd "$PKM_HOME/app/server" && uv run python -m pkm.backup.restore \
     --data-dir "$PKM_HOME/data" \
     "$PKM_HOME/backups/sqlite/pkm-YYYY-MM-DD.sqlite3"
   ```
3. Start it again:
   ```bash
   launchctl bootstrap "gui/$UID" \
     "$HOME/Library/LaunchAgents/com.$USER.pkm.server.plist"
   ```
4. Verify with `deploy/smoke.sh` or a manual login.

Never restore with a plain `cp`. The helper also gives the database a new
`db_generation`, so every device rebuilds its local copy from the server on
its next sync and keeps its unsent edits. A copied file would leave a device
that pulled past the snapshot missing the restored rows.

`pkm.sqlite3-wal` and `-shm` beside a stopped database are normal, and the
helper folds them in. If it refuses with "Stop the server first", another
connection still has the database open. An idle server holds no connection
and passes the check, so step 1 is still needed. The mechanism is in
[import-export-and-backup.md § Restore](../docs/architecture/import-export-and-backup.md#restore).

## Troubleshooting

- `launchctl print "gui/$UID/com.$USER.pkm.server"`: job state, last exit
  status (an exit code of 128+N means the server died of signal N), and the
  pid if running (use `.backup` or `.icloud-backup` for the
  backup jobs).
- `$PKM_HOME/logs/server.log` / `access.log`: today's server log and request
  log; `server.log.YYYY-MM-DD` and `access.log.YYYY-MM-DD` hold the last 30
  days (`grep … $PKM_HOME/logs/server.log*` searches them all).
- `$PKM_HOME/logs/server.err.log` / `server.out.log`: what escaped logging,
  such as a startup crash. Check these when the service won't stay up.
- `$PKM_HOME/logs/backup.*.log` and `icloud-backup.*.log`: the backup jobs'
  stdout/stderr.
- `tailscale serve status`: confirms the HTTPS Serve forward to the local
  port is still configured after a Tailscale update or reboot.

Known symptoms and their fixes:

| Symptom | Fix |
|---|---|
| The server restarts every 10 s; `server.err.log` says `cannot run …/.venv/bin/python` | The venv's uv-managed interpreter was removed. `uv sync` in `$PKM_HOME/app/server`, then `launchctl kickstart -k` the server |
| The server crash-loops with `OSError 49` after Tailscale is reinstalled | The node's Tailscale IP changed: update `bind_hosts`, and re-run the `tailscale serve` line from `install.sh` |
| `install.sh` stops at `Bootstrap failed: 5: Input/output error` and leaves the server unloaded | Re-run the `launchctl bootstrap` line |
| HTTPS over the tailnet connects but the TLS handshake hangs on a recreated node | Serve is waiting on a new Let's Encrypt certificate. Retry patiently; Let's Encrypt allows five failed validations per hostname per hour |
| On the Serve hostname, live updates never connect and edits stay queued; `access.log` shows `403` on `POST /api/ops` | The origin is missing from `serve_origins` (step 4 of [First install](#first-install)) |
| After a deploy, an open tab can't load the PDF viewer or a diagram or formula | The tab runs the old bundle. Reload it |
| `Local copy::` files answer 503, read `unchecked` or answer `too many file opens are in flight`; the log shows `local open probe … timed out` | The iCloud consent prompt is pending ([The launcher](#the-launcher)). Click Allow at the Mac, or restart the server; until someone can, unset `local_docs_root`. Full Disk Access is the wrong setting |

## Image descriptions (optional)

LLM image descriptions stay off until an OpenAI key is available. Put the key
in a file and restart:

```bash
echo -n "sk-..." > "$PKM_HOME/openai_key"
chmod 600 "$PKM_HOME/openai_key"
launchctl kickstart -k "gui/$UID/com.$USER.pkm.server"
```

The key sits at the `PKM_HOME` root, outside `data/`, so nothing that copies
or exports the data dir picks it up. Set a different path with
`openai_api_key_file` in `config.json` (resolved relative to `config.json`,
like `db_file`). The file
takes precedence over an `OPENAI_API_KEY` in the service environment. After
restarting, check `/settings` (or `GET /api/assets/describe-status`) to
confirm the key was picked up.

## Assistant prerequisites

The embedded assistant runs the `claude` CLI through the Claude Agent SDK.
The launchd service user needs:

- nothing extra installed: the SDK bundles its own `claude` binary (a system
  `claude` matters only if the SDK's `cli_path` is overridden)
- a logged-in Claude subscription (`claude /login` as the service user).
  Credentials resolve from `~/.claude` and the login Keychain, so the plist
  must run as that user with `HOME` set (the template does)
- no `ANTHROPIC_API_KEY` in the service environment, since it would override
  the subscription login and bill per token

If the login is missing, the assistant returns an error in the chat and the
rest of the app is unaffected.

The harness receives only an allow-list of the service's environment
([assistant.md § Harness confinement](../docs/architecture/assistant.md#harness-confinement)),
so proxy and CA-certificate variables, `ANTHROPIC_BASE_URL` and
`CLAUDE_CODE_*` switches set on the service do not reach it. A variable the
CLI needs must be added to `HOST_ENV` in
`server/src/pkm/assistant/harness_env.py`.

The optional `glm` model (z.ai GLM Coding Plan) is enabled by a key file at
`$PKM_HOME/zai_key` (mode 600). Set a different path with `zai_api_key_file`
in `config.json`; the `ZAI_API_KEY` env var is the fallback, and the file
takes precedence. Requests go to z.ai's Anthropic-compatible endpoint and
draw on the flat-rate plan. Without the key, the model picker doesn't offer
`glm`. With it, `glm` becomes the default model. The OpenAI and z.ai keys are
read once at service start, so adding, rotating or deleting either needs a
service restart.
