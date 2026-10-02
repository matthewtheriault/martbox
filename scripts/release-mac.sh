#!/usr/bin/env bash
# Builds the Mac app and uploads it to the GitHub release for the current
# package.json version, so Mac installs can update themselves.
#
# The release itself is created by CI when a vX.Y.Z tag is pushed (the
# Windows build). Run this afterwards, on a Mac. See docs/RELEASING.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  echo "error: GitHub release $TAG doesn't exist yet. Push the $TAG tag and let CI create it first." >&2
  exit 1
fi

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "warning: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — the build" >&2
  echo "         will be signed but not notarized, so macOS warns on first open." >&2
fi

bash scripts/check-sensitive.sh

# The sidecar build needs Go; a user-local SDK install isn't always on PATH.
if ! command -v go >/dev/null 2>&1 && [[ -x "$HOME/sdk/go/bin/go" ]]; then
  export PATH="$HOME/sdk/go/bin:$PATH"
fi

rm -f release/latest-mac.yml release/MartBox-"$VERSION"*
npm run build:mac

shopt -s nullglob
FILES=(
  release/latest-mac.yml
  release/MartBox-"$VERSION"*.dmg
  release/MartBox-"$VERSION"*.zip
  release/MartBox-"$VERSION"*.blockmap
)
if [[ ! -f release/latest-mac.yml ]]; then
  echo "error: release/latest-mac.yml wasn't generated — check the publish block in electron-builder.yml." >&2
  exit 1
fi

gh release upload "$TAG" "${FILES[@]}" --clobber
echo "Uploaded ${#FILES[@]} files to $TAG."
