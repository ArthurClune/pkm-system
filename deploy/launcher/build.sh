#!/bin/bash
# Build and ad-hoc sign the launcher: build.sh <output-path>
# The explicit signing identifier keeps the code identity stable across
# builds of the same source; macOS keys file-access consent to it.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <output-path>" >&2
  exit 64
fi
OUT="$1"
SRC="$(cd "$(dirname "$0")" && pwd)/pkm-server.swift"

mkdir -p "$(dirname "$OUT")"
swiftc -O -o "$OUT" "$SRC"
codesign --force -s - -i "com.$(whoami).pkm.server" "$OUT"
codesign -dvvv "$OUT" 2>&1 | grep -E '^(Identifier|CDHash)='
