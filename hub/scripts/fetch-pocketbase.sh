#!/usr/bin/env bash
# Fetch the pinned PocketBase binary into hub/bin/pocketbase and verify its checksum.
set -euo pipefail

PB_VERSION="0.40.6"
HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$HUB_DIR/bin"
OUT="$OUT_DIR/pocketbase"

if [ -x "$OUT" ] && "$OUT" --version 2>/dev/null | grep -q "$PB_VERSION"; then
  echo "pocketbase v$PB_VERSION already at $OUT"
  exit 0
fi

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

ZIP="pocketbase_${PB_VERSION}_${OS}_${ARCH}.zip"
BASE="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading $ZIP"
curl -fsSL -o "$TMP/$ZIP" "$BASE/$ZIP"
curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"

EXPECTED="$(awk -v f="$ZIP" '$2 == f { print $1 }' "$TMP/checksums.txt")"
if [ -z "$EXPECTED" ]; then
  echo "no checksum for $ZIP in checksums.txt" >&2; exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$ZIP" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TMP/$ZIP" | awk '{print $1}')"
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "checksum mismatch for $ZIP: expected $EXPECTED got $ACTUAL" >&2; exit 1
fi
echo "checksum ok ($ACTUAL)"

mkdir -p "$TMP/x" "$OUT_DIR"
unzip -q -o "$TMP/$ZIP" pocketbase -d "$TMP/x"
mv "$TMP/x/pocketbase" "$OUT"
chmod 0755 "$OUT"
"$OUT" --version
