# Deploying PKM

Runs the server and nightly backup as launchd services on a Mac, fronted by
Tailscale Serve for HTTPS access from other devices on the tailnet.

## Layout

Everything lives under `$PKM_HOME` (default `~/.config/pkm`):

```
~/.config/pkm/
  app/        git checkout of this repo (cloned by install.sh)
  data/       config.json, pkm.sqlite3, assets/ — the live database
  backups/    nightly sqlite snapshots + markdown/asset export
  logs/       server.{out,err}.log, backup.{out,err}.log
```

`data/` is never touched by `install.sh` or `update.sh` beyond directory
creation — an existing `config.json` and database are left alone.

## First install

1. Run `deploy/install.sh` from a checkout of this repo (any location; it
   clones a fresh copy into `$PKM_HOME/app` if one doesn't exist yet,
   renders both launchd plists from the templates in this directory, and
   loads them with `launchctl bootstrap`). It also configures Tailscale
   Serve to forward HTTPS on the tailnet to the local server port.
2. If `$PKM_HOME/data/config.json` doesn't exist yet, create it:
   ```
   cd "$PKM_HOME/app/server" && uv run python -m pkm.server.setup \
     --data-dir "$PKM_HOME/data" --web-dist ../web/dist
   ```
   This prompts for the app password and writes `config.json` (mode 0600)
   with the password hash, session secret, and `web_dist`.
3. Add the `bind_hosts` line `install.sh` printed (loopback + your
   Tailscale IP) to `config.json` by hand — `setup.py` doesn't know your
   Tailscale IP, so this line isn't written automatically:
   ```json
   "bind_hosts": ["127.0.0.1", "100.x.y.z"],
   ```
4. Restart the server so it picks up the new config:
   `launchctl kickstart -k "gui/$UID/com.$USER.pkm.server"`.
5. Run `deploy/smoke.sh` to verify the install end-to-end.

## Updating

Run `deploy/update.sh` (from the deployed checkout, i.e.
`$PKM_HOME/app/deploy/update.sh`). It does a fast-forward `git pull`,
`uv sync`s the server, rebuilds the web app, and kickstarts the server
service. It does not touch the backup service's schedule or config.

## Backups

The nightly `pkm.backup` launchd job writes to `$PKM_HOME/backups/`:

- `sqlite/` — one `pkm-YYYY-MM-DD.sqlite3` snapshot per night, taken from a
  read-only connection. Rotation keeps the newest 14 daily snapshots plus
  the latest snapshot of every calendar month, forever.
- `export/` — a plain-text markdown + assets export of the same snapshot,
  auto-committed to a local git repo each night (assets themselves are not
  committed to that git history, just present on disk).

`backups/` is the one directory worth syncing off-machine (rsync, Time
Machine, cloud sync) — everything else is either reproducible (`app/`) or
derived from what's in `backups/` (`data/`).

## Restore

1. Stop the server: `launchctl bootout "gui/$UID/com.$USER.pkm.server"`.
2. Copy the desired dated snapshot over the live database:
   `cp "$PKM_HOME/backups/sqlite/pkm-YYYY-MM-DD.sqlite3" "$PKM_HOME/data/pkm.sqlite3"`.
3. Start it again: `launchctl bootstrap "gui/$UID" \
   "$HOME/Library/LaunchAgents/com.$USER.pkm.server.plist"`.
4. Verify with `deploy/smoke.sh` or a manual login.

## Troubleshooting

- `launchctl print "gui/$UID/com.$USER.pkm.server"` — job state, last exit
  status, and the pid if running (swap `.server` for `.backup` for the
  backup job).
- `$PKM_HOME/logs/server.out.log` / `server.err.log` — server stdout/stderr
  (same pattern for `backup.*.log`).
- `tailscale serve status` — confirms the HTTPS Serve forward to the local
  port is still configured after a Tailscale update or reboot.
