#!/usr/bin/env bash
# Builds the Mac app and uploads it to the GitHub release for the current
# package.json version, so Mac installs can update themselves.
#
# The release itself is created by CI when a vX.Y.Z tag is pushed (the
# Windows build). Run this afterwards, on a Mac. See docs/RELEASING.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Two runs at once share release/ and clobber each other's build output
# (it happened with 0.5.1). Refuse to start while another one is running.
LOCK_DIR="${TMPDIR:-/tmp}/martbox-release-mac.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "error: another release:mac is already running (lock: $LOCK_DIR). If it isn't, remove the lock folder and retry." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

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

# Only this version's build output is kept locally — older versions are on
# their GitHub releases, and each set of builds is over a gigabyte.
shopt -s nullglob
for f in release/MartBox-* release/latest-mac.yml release/latest.yml; do
  case "$(basename "$f")" in
    MartBox-"$VERSION"[.-]* | MartBox-Setup-"$VERSION".*) ;;
    *) rm -f "$f" ;;
  esac
done
rm -f release/latest-mac.yml release/MartBox-"$VERSION"[.-]*

# hdiutil sometimes fails resizing a dmg ("Resource temporarily
# unavailable", exit 35) — and the failed build leaves its temporary image
# mounted, so the next attempt fails the same way. Clear electron-builder's
# leftovers and retry the packaging step (code and sidecar are built once).
detach_stale_images() {
  hdiutil info | awk '
    /^image-path/ { img = ($3 ~ /\/T\/t-[^\/]+\/[0-9]+\.dmg$/) }
    img && /^\/dev\/disk[0-9]+[ \t]/ { print $1; img = 0 }
  ' | while read -r dev; do
    hdiutil detach "$dev" -force >/dev/null 2>&1 || true
  done
}

# See scripts/hdiutil-shim/hdiutil: detaches a just-created dmg before it's resized.
export PATH="$ROOT_DIR/scripts/hdiutil-shim:$PATH"

npm run build:sidecar
npx electron-vite build
for attempt in 1 2 3; do
  detach_stale_images
  rm -f release/latest-mac.yml release/MartBox-"$VERSION"[.-]*
  if npx electron-builder --mac --publish never; then
    break
  fi
  if [[ $attempt == 3 ]]; then
    echo "error: Mac packaging failed 3 times." >&2
    exit 1
  fi
  echo "Mac packaging failed (attempt $attempt) — retrying." >&2
  sleep 5
done
detach_stale_images

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
