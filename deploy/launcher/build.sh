#!/bin/bash
# Build and ad-hoc sign the launcher: build.sh <output-path>
# macOS keys file-access consent to the binary's path and code hash. The
# explicit signing identifier only keeps that hash reproducible: rebuilding
# unchanged source with the same toolchain gives the same hash.
# The binary is built in a scratch directory beside the output and moved into
# place once signed, so a failed build never leaves a half-signed launcher at
# the output path. It is built under the output's own file name: the linker
# records that name in the binary, so a differently named scratch file would
# change the code hash on every build.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <output-path>" >&2
  exit 64
fi
OUT="$1"
SRC="$(cd "$(dirname "$0")" && pwd)/pkm-server.swift"
mkdir -p "$(dirname "$OUT")"
TMPDIR_BUILD="$(mktemp -d "$(dirname "$OUT")/.pkm-server-build.XXXXXX")"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT
TMP="$TMPDIR_BUILD/$(basename "$OUT")"

swiftc -O -o "$TMP" "$SRC"
codesign --force -s - -i "com.$(whoami).pkm.server" "$TMP"
codesign --verify "$TMP"
mv -f "$TMP" "$OUT"
codesign -dvvv "$OUT" 2>&1 | grep -E '^(Identifier|CDHash)='
