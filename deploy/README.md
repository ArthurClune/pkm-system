# Deploying PKM

Runs the server, the nightly backup and the nightly iCloud mirror as launchd
services on a Mac, behind Tailscale Serve for HTTPS access from other devices
on the tailnet.

## Layout

Everything lives under `$PKM_HOME` (default `~/.config/pkm`):

```
~/.config/pkm/
  app/        git clone of the local dev checkout (made by install.sh)
  data/       config.json, pkm.sqlite3, assets/ — the live database
  backups/    nightly sqlite snapshots + markdown/asset export
  logs/       server.log, access.log (+ 30 dated copies of each),
              server.{out,err}.log, backup.{out,err}.log,
              icloud-backup.{out,err}.log
```

The server writes `server.log` (lifecycle, errors, `pkm.*` loggers) and
`access.log` (one line per request, with its duration) itself, because the
plist passes `--log-dir`. Both rotate at midnight. Yesterday's file is
`server.log.YYYY-MM-DD`, and copies older than 30 days are deleted. The
launchd `server.{out,err}.log` files catch only what escapes logging, such as
a crash before logging starts. The backup jobs' logs grow by a few KB a
month and are not rotated.

`install.sh` and `update.sh` only create `data/`; they never modify an
existing `config.json` or database.

## First install

1. Run `deploy/install.sh` from any checkout of this repo or its worktrees.
   If `$PKM_HOME/app` doesn't exist, it clones the main checkout there, so the
   clone's `origin` is that local path. It then renders the three launchd
   plists from the templates in this directory, loads them with
   `launchctl bootstrap`, and configures Tailscale Serve to forward HTTPS on
   the tailnet to the local server port.
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
4. Add the `bind_hosts` line that `install.sh` printed (loopback plus your
   Tailscale IP) to `config.json` by hand. `setup.py` doesn't know your
   Tailscale IP:
   ```json
   "bind_hosts": ["127.0.0.1", "100.x.y.z"],
   ```
5. Restart the server so it picks up the new config:
   `launchctl kickstart -k "gui/$UID/com.$USER.pkm.server"`.
6. Run `deploy/smoke.sh` to verify the install end-to-end.

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

`update.sh` does not re-render the launchd plists. When an update changes a
`*.plist.template`, run `$PKM_HOME/app/deploy/install.sh` after it, which
re-renders and reloads all three jobs.

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
Once `main` is older than 30 days, the oldest incremental is folded into it
(files moved in, deletions applied, manifest replaced) and removed. The oldest
restorable point stays about 30 days back, and the total stays at one tree
plus 30 days of changes. The data mirror excludes the live `pkm.sqlite3` and
its `-wal`/`-shm` files, since a copy taken while the server runs is not a
consistent snapshot; `db/` covers the database.

Restore the data dir as of a date into an empty folder, then pair it with
the matching `db/` snapshot:

```bash
"$PKM_HOME/app/deploy/icloud_backup.py" restore \
  --dest "$HOME/Library/Mobile Documents/com~apple~CloudDocs/pkm backups" \
  --date 2026-09-01 --out /tmp/pkm-restore
```

The restore checks the result against that day's manifest and fails on any
mismatch. If iCloud has evicted files ("Optimize Mac Storage"), the restore
and the nightly fold ask `brctl` to download them and wait. A file that never
arrives aborts the run, and the next night retries.

## Restore

1. Stop the server: `launchctl bootout "gui/$UID/com.$USER.pkm.server"`.
2. Copy the dated snapshot over the live database:
   `cp "$PKM_HOME/backups/sqlite/pkm-YYYY-MM-DD.sqlite3" "$PKM_HOME/data/pkm.sqlite3"`.
3. Start it again:
   ```bash
   launchctl bootstrap "gui/$UID" \
     "$HOME/Library/LaunchAgents/com.$USER.pkm.server.plist"
   ```
4. Verify with `deploy/smoke.sh` or a manual login.

## Troubleshooting

- `launchctl print "gui/$UID/com.$USER.pkm.server"`: job state, last exit
  status, and the pid if running (use `.backup` or `.icloud-backup` for the
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

Known failures are listed by symptom in
[docs/troubleshooting.md](../docs/troubleshooting.md).

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

The optional `glm` model (z.ai GLM Coding Plan) is enabled by a key file at
`$PKM_HOME/zai_key` (mode 600). Set a different path with `zai_api_key_file`
in `config.json`; the `ZAI_API_KEY` env var is the fallback, and the file
takes precedence. Requests go to z.ai's Anthropic-compatible endpoint and
draw on the flat-rate plan. Without the key, the model picker doesn't offer
`glm`. With it, `glm` becomes the default model. The OpenAI and z.ai keys are
read once at service start, so adding, rotating or deleting either needs a
service restart.
