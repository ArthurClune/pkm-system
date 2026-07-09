#!/bin/bash
# Install/refresh the PKM launchd services on this machine. Idempotent:
# re-running updates plists and Tailscale Serve config; it never touches
# data/, backups/, or an existing config.json.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKM_HOME="${PKM_HOME:-$HOME/.config/pkm}"
UV="$(command -v uv)"
TAILSCALE="$(command -v tailscale ||
  echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
USER_NAME="$(whoami)"
PORT=8974

mkdir -p "$PKM_HOME/data" "$PKM_HOME/backups" "$PKM_HOME/logs"
if [ ! -e "$PKM_HOME/app" ]; then
  git clone "$(git -C "$REPO" remote get-url origin)" "$PKM_HOME/app"
fi

render() { # render <template> <dest>
  sed -e "s|{{USER}}|$USER_NAME|g" \
      -e "s|{{UV}}|$UV|g" \
      -e "s|{{PKM_HOME}}|$PKM_HOME|g" "$1" > "$2"
}

for svc in server backup; do
  LABEL="com.$USER_NAME.pkm.$svc"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  render "$REPO/deploy/com.PLACEHOLDER.pkm.$svc.plist.template" "$PLIST"
  plutil -lint -s "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
done

"$TAILSCALE" serve --bg --https=443 "http://127.0.0.1:$PORT"

TS_IP="$("$TAILSCALE" ip -4 | head -1)"
echo "Installed. Ensure $PKM_HOME/data/config.json contains:"
echo "  \"bind_hosts\": [\"127.0.0.1\", \"$TS_IP\"],"
echo "  \"web_dist\": \"../app/web/dist\""
echo "(create a fresh config with pkm.server.setup — see deploy/README.md)"
