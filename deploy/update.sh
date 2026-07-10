#!/bin/bash
# Update the prod checkout this script lives in, then restart the service.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd -P)"
PKM_HOME="${PKM_HOME:-$HOME/.config/pkm}"
DEPLOYED_APP="$(cd "$PKM_HOME/app" 2>/dev/null && pwd -P || true)"
if [ "${PKM_UPDATE_FORCE:-}" != "1" ] && [ "$APP" != "$DEPLOYED_APP" ]; then
  echo "refusing to run: '$APP' is not the deployed app" \
       "(expected '$PKM_HOME/app'). This looks like a dev checkout, and" \
       "running update.sh here would rebuild it while kickstarting the" \
       "prod service, silently no-op'ing the deploy. Run" \
       "$PKM_HOME/app/deploy/update.sh instead, or set PKM_UPDATE_FORCE=1" \
       "to override." >&2
  exit 1
fi
git -C "$APP" pull --ff-only
(cd "$APP/server" && uv sync)
(cd "$APP/web" && pnpm install --frozen-lockfile && pnpm build)
launchctl kickstart -k "gui/$(id -u)/com.$(whoami).pkm.server"
echo "updated to $(git -C "$APP" rev-parse --short HEAD)"
