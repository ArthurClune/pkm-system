#!/bin/bash
# Update the prod checkout this script lives in, then restart the service.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$APP" pull --ff-only
(cd "$APP/server" && uv sync)
(cd "$APP/web" && pnpm install --frozen-lockfile && pnpm build)
launchctl kickstart -k "gui/$(id -u)/com.$(whoami).pkm.server"
echo "updated to $(git -C "$APP" rev-parse --short HEAD)"
