---
# pkm-wmz1
title: Stable launchd launcher so the iCloud file permission survives uv upgrades
status: in-progress
type: task
priority: normal
created_at: 2026-10-11T12:09:52Z
updated_at: 2026-10-11T14:10:52Z
blocked_by:
    - pkm-a7i8
---

Every `brew upgrade uv` silently breaks Local copy files under launchd until someone clicks Allow on biber's screen.

## Why

macOS privacy consent (TCC) is granted to the launchd job's own binary, the "responsible process", not to the Python it spawns. Today that binary is `/opt/homebrew/bin/uv`. Homebrew's uv is ad-hoc signed with no Team ID and lives at a versioned Cellar path, so each upgrade is a new client to TCC. TCC.db holds separate `kTCCServiceFileProviderDomain` grants for uv 0.12.13 (2026-09-21) and 0.12.23 (2026-10-11). Between an upgrade and the click, opening any file in the iCloud container blocks (see pkm-a7i8).

Moving `/pkm` doesn't help: the consent covers iCloud Drive file access generally, and the folder must stay in Readdle Documents' iCloud container.

## Design

A tiny launcher binary at a fixed path outside the app checkout, `~/.config/pkm/bin/pkm-server`, becomes the launchd job. It is built once and never rebuilt casually, so its code identity (and the TCC grant attached to it) survives uv, Homebrew, Python and app deploys.

- **Spawn, don't exec.** It starts the venv Python as a child and stays alive as its parent. Exec would hand the process identity to Python and lose the point.
- Forwards SIGTERM/SIGINT/SIGHUP to the child, waits, and exits with the child's status (or 128+signal), so the server's graceful shutdown inside launchd's 20 s window still works.
- No argument parsing beyond passing argv[1...] through; no config, no network, no dependencies.
- Written in **Swift** (ships with Xcode on biber; memory-safe; `posix_spawn` + `DispatchSource` signal sources, no packages). Rust isn't installed and would bring a toolchain and crates for a 70-line program.
- Ad-hoc signed with an explicit identifier (`codesign -s - -i com.<user>.pkm.server`). A self-signed certificate (so a rebuild keeps the grant) is out of scope unless rebuilds turn out to be needed.

## Todo

- [x] Launcher source in `deploy/` (Swift), header `// pattern: Imperative Shell`
- [x] Test first (pytest): compile to a temp dir; exit status passes through; SIGTERM to the launcher reaches the child and the launcher exits after the child does; a child killed by a signal yields 128+signal
- [x] `install.sh`: build and sign into `$PKM_HOME/bin/pkm-server` only if missing (an explicit flag to force a rebuild, with a warning that it re-triggers the consent prompt)
- [x] Server plist template: run `pkm-server <PKM_HOME>/app/server/.venv/bin/python -m pkm.server.run …` instead of `uv run`; backup jobs stay on `uv run` (they never open iCloud files)
- [x] `deploy/README.md`: layout, why the launcher must not be rebuilt casually, how to re-grant (System Settings, or open a local file and click Allow on the console)
- [x] Update `backend.md` / `overview.md` wherever they say the service runs under `uv run`
- [ ] Cutover on biber: `install.sh`, open a local PDF, Allow for pkm-server on the console, verify a 200/206 `/api/local/` line in `access.log` and the PDF on the iPad; confirm TCC.db shows the grant against `pkm-server`
