#!/usr/bin/env bash
# Property-check gate. Usage: proptest/check.sh [auto|server|web] [--seed N]
# Design: docs/superpowers/specs/2026-10-02-property-checks-server-design.md
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
cd "$repo/server"
TZ=Europe/London PYTHONPATH="$repo/server/tooling" exec uv run python -m proptest.run "$@"
