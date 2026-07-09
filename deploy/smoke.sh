#!/bin/bash
# Post-deploy smoke: run on the target machine after install.sh.
# Checks loopback + tailscale-ip binds, Serve HTTPS, login, an authed
# read, the asset auth gate, and a REAL websocket upgrade (plan-5 lesson:
# TestClient suites pass even when real WS upgrades would fail).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8974
TAILSCALE="$(command -v tailscale ||
  echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
TS_IP="$("$TAILSCALE" ip -4 | head -1)"
HOST_DNS="$("$TAILSCALE" status --json |
  uv run --project "$APP/server" python -c \
  'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
BASE="https://$HOST_DNS"

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || fail "loopback healthz"
# macOS doesn't hairpin traffic to the machine's own tailscale IP (it routes
# into utun and never comes back), so curl from here would hang. Assert the
# LISTEN socket instead; reachability is verified end-to-end from another
# tailnet device.
lsof -nP "-iTCP@$TS_IP:$PORT" -sTCP:LISTEN >/dev/null \
  || fail "tailscale-ip bind missing"
curl -fsS "$BASE/healthz" >/dev/null || fail "serve https healthz"

read -rs -p "app password: " PW; echo
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
curl -fsS -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"password\": \"$PW\"}" "$BASE/api/login" >/dev/null || fail "login"
curl -fsS -b "$JAR" "$BASE/api/titles" >/dev/null || fail "authed read"

BOGUS="$BASE/assets/$(printf 'a%.0s' {1..64})/x" # auth runs before lookup
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BOGUS")"
[ "$CODE" = "401" ] || fail "asset without cookie returned $CODE (want 401)"

# HttpOnly cookies are stored as "#HttpOnly_<domain> ..." — match both forms
COOKIE="$(awk 'NF==7 && ($0 ~ /^#HttpOnly_/ || $0 !~ /^#/) {print $6"="$7}' \
  "$JAR" | head -1)"
uv run --project "$APP/server" python - "$HOST_DNS" "$COOKIE" <<'PY' \
  || fail "websocket upgrade"
import asyncio, sys
import websockets


async def main() -> None:
    host, cookie = sys.argv[1], sys.argv[2]
    async with websockets.connect(f"wss://{host}/api/ws",
                                  additional_headers={"Cookie": cookie}):
        pass

asyncio.run(main())
PY
echo "SMOKE OK: loopback, tailscale-ip bind, serve https, login, asset gate, websocket"
