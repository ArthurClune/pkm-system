#!/usr/bin/env bash
# Perf regression check. Usage: perf/check.sh [auto|backend|frontend] [--bootstrap|--rebaseline] [--runs N]
# Design: docs/superpowers/specs/2026-09-26-perf-regression-checks-design.md
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
cd "$repo/server"
TZ=Europe/London PYTHONPATH="$repo/server/tooling" exec uv run python -m perfcheck.run "$@"
