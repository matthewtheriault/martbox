#!/usr/bin/env bash
# Cross-compiles the Go tsnet sidecar for every platform/arch MartBox ships
# (electron-builder.yml targets: mac arm64+x64, win x64, linux x64) into
# resources/sidecar/<goos>-<goarch>/martbox-sidecar[.exe].
#
# scripts/afterPackSidecar.js picks the one matching binary for each
# packaged target at build time. Run this before build:mac/build:win/build:linux.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/sidecar"
OUT_DIR="$ROOT_DIR/resources/sidecar"

if ! command -v go >/dev/null 2>&1; then
  echo "error: go is not on PATH. Install it (e.g. https://go.dev/dl/) and retry." >&2
  exit 1
fi

rm -rf "$OUT_DIR"

# goos:goarch:ext triples
TARGETS=(
  "darwin:arm64:"
  "darwin:amd64:"
  "windows:amd64:.exe"
  "linux:amd64:"
)

cd "$SIDECAR_DIR"

for target in "${TARGETS[@]}"; do
  IFS=":" read -r goos goarch ext <<< "$target"
  dest="$OUT_DIR/${goos}-${goarch}"
  mkdir -p "$dest"
  echo "building sidecar for ${goos}/${goarch}..."
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -o "$dest/martbox-sidecar${ext}" .
done

echo "sidecar binaries built in $OUT_DIR"
