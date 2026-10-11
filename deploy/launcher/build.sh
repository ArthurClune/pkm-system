#!/bin/bash
# Build and ad-hoc sign the launcher: build.sh <output-path>
# macOS keys file-access consent to the binary's path and code hash. The
# explicit signing identifier only keeps that hash reproducible: rebuilding
# unchanged source with the same toolchain gives the same hash.
# The binary is built beside the output and moved into place once signed, so
# a failed build never leaves a half-signed launcher at the output path.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <output-path>" >&2
  exit 64
fi
OUT="$1"
SRC="$(cd "$(dirname "$0")" && pwd)/pkm-server.swift"
TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT

mkdir -p "$(dirname "$OUT")"
swiftc -O -o "$TMP" "$SRC"
codesign --force -s - -i "com.$(whoami).pkm.server" "$TMP"
codesign --verify "$TMP"
mv -f "$TMP" "$OUT"
codesign -dvvv "$OUT" 2>&1 | grep -E '^(Identifier|CDHash)='
