#!/bin/bash
# Install/refresh the PKM launchd services on this machine. Idempotent:
# re-running updates plists and Tailscale Serve config; it never touches
# data/, backups/, or an existing config.json. The launcher binary is built
# only when missing: --rebuild-launcher forces it. A rebuild after a source or
# Swift toolchain change gives the binary a new identity, and macOS then asks
# for iCloud file access again.
set -euo pipefail

REBUILD_LAUNCHER=0
case "${1:-}" in
  "") ;;
  --rebuild-launcher) REBUILD_LAUNCHER=1 ;;
  *) echo "usage: $0 [--rebuild-launcher]" >&2; exit 64 ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKM_HOME="${PKM_HOME:-$HOME/.config/pkm}"
UV="$(command -v uv)"
TAILSCALE="$(command -v tailscale ||
  echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
USER_NAME="$(whoami)"
PORT=8974

mkdir -p "$PKM_HOME/data" "$PKM_HOME/backups" "$PKM_HOME/logs"
if [ ! -e "$PKM_HOME/app" ]; then
  # Clone the main checkout, not this one: a worktree is deleted after use,
  # and update.sh deploys from whatever path the clone records as origin.
  SRC="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
  git clone "$SRC" "$PKM_HOME/app"
fi

LAUNCHER="$PKM_HOME/bin/pkm-server"
if [ "$REBUILD_LAUNCHER" = 1 ] || [ ! -x "$LAUNCHER" ]; then
  if [ "$REBUILD_LAUNCHER" = 1 ]; then
    echo "WARNING: if the launcher source or Swift toolchain changed, the rebuilt" >&2
    echo "binary has a new identity and macOS will ask for iCloud file access" >&2
    echo "again (click Allow at the Mac's screen)." >&2
  fi
  # Build from the deployed checkout so the binary matches deployed main.
  "$PKM_HOME/app/deploy/launcher/build.sh" "$LAUNCHER"
  shasum -a 256 "$PKM_HOME/app/deploy/launcher/pkm-server.swift" |
    cut -d' ' -f1 > "$LAUNCHER.source-sha256"
fi

# The server runs from the venv directly (the launcher does not go through
# uv run, which used to create it on first start).
(cd "$PKM_HOME/app/server" && "$UV" sync)

render() { # render <template> <dest>
  sed -e "s|{{USER}}|$USER_NAME|g" \
      -e "s|{{UV}}|$UV|g" \
      -e "s|{{HOME}}|$HOME|g" \
      -e "s|{{PKM_HOME}}|$PKM_HOME|g" "$1" > "$2"
}

wait_unloaded() { # wait_unloaded <service target>
  # bootout returns while the job is still shutting down (the server's
  # graceful shutdown takes seconds), and a bootstrap in that window fails
  # with "5: Input/output error". launchd SIGKILLs a job 20s after SIGTERM,
  # so 30s is enough.
  local tries=150
  while launchctl print "$1" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "timed out waiting for $1 to unload" >&2
      return 1
    fi
    sleep 0.2
  done
}

for svc in server backup icloud-backup; do
  LABEL="com.$USER_NAME.pkm.$svc"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  render "$REPO/deploy/com.PLACEHOLDER.pkm.$svc.plist.template" "$PLIST"
  plutil -lint -s "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  wait_unloaded "gui/$(id -u)/$LABEL"
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
done

"$TAILSCALE" serve --bg --https=443 "http://127.0.0.1:$PORT"

TS_IP="$("$TAILSCALE" ip -4 | head -1)"
echo "Installed. Ensure $PKM_HOME/data/config.json contains:"
echo "  \"bind_hosts\": [\"127.0.0.1\", \"$TS_IP\"],"
echo "  \"web_dist\": \"../app/web/dist\""
echo "(create a fresh config with pkm.server.setup — see deploy/README.md)"
