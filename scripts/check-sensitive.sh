#!/usr/bin/env bash
# Blocks commits (via .githooks/pre-commit) and CI runs that would publish
# personal, network, or legally risky content to this public repo: API keys
# and tokens, private/tailnet IPs, local home-directory paths, personal email
# addresses, piracy-related terms, and ROM/BIOS/playlist files.
#
#   scripts/check-sensitive.sh           scan every tracked file
#   scripts/check-sensitive.sh --staged  scan only what's staged for commit
#
# A false positive can be silenced for one line by adding the marker
# `sensitive-scan: allow` to that line.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--staged" ]]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR)
else
  files=$(git ls-files)
fi
[[ -z "$files" ]] && exit 0

# This script and the lockfile are exempt from content checks (the script
# necessarily contains the patterns; the lockfile is full of hashes).
files=$(echo "$files" | grep -v -E '^(scripts/check-sensitive\.sh|package-lock\.json|sidecar/go\.sum|LICENSE)$' || true)

fail=0

# 1. Files that must never be committed, by extension.
blocked_ext='\.(gb|gbc|gba|nes|fds|sfc|smc|n64|z64|v64|nds|3ds|gcm|rvz|wbfs|wad|iso|cue|chd|pbp|cso|ecm|m3u|m3u8|db|sqlite|sqlite3|pem|p12|p8|key|mobileprovision|env)$'
bad_files=$(echo "$files" | grep -i -E "$blocked_ext" || true)
if [[ -n "$bad_files" ]]; then
  echo "✖ Blocked file types (ROMs, BIOS/disc images, playlists, databases, keys):"
  echo "$bad_files" | sed 's/^/    /'
  fail=1
fi

# 2. Content patterns.
patterns=(
  'tskey-[A-Za-z0-9]'                                        # Tailscale auth keys
  'gh[opsu]_[A-Za-z0-9]{20,}|github_pat_'                    # GitHub tokens
  'sk-ant-|sk-[A-Za-z0-9]{32,}'                              # API secret keys
  'BEGIN [A-Z ]*PRIVATE KEY'                                 # private keys
  '\b[0-9a-f]{31,32}\b'                                      # TMDb-style hex keys
  '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'  # tailnet IPs
  '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b'                     # LAN IPs
  '\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'               # LAN IPs
  '\.ts\.net\b'                                              # tailnet hostnames
  '/Users/[A-Za-z]|[A-Z]:\\\\Users\\\\|/home/[a-z]'          # home-directory paths
  '[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|proton(mail)?)\.'  # personal emails
  'torrent|magnet:\?|\bpirat|warez|\bscene release|rarbg|\byts\b|eztv|1337x|uindex|thepiratebay|nyaa'
  '\broms? (site|download)|download (the )?roms?|bios (download|dump)'
)

while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  # Skip binary files.
  if ! grep -Iq . "$f" 2>/dev/null; then continue; fi
  for p in "${patterns[@]}"; do
    hits=$(grep -n -i -E "$p" "$f" | grep -v 'sensitive-scan: allow' || true)
    if [[ -n "$hits" ]]; then
      echo "✖ $f matches /$p/:"
      echo "$hits" | cut -c1-160 | sed 's/^/    /'
      fail=1
    fi
  done
done <<< "$files"

if [[ $fail -ne 0 ]]; then
  echo
  echo "Sensitive-content check failed. Remove the content above before committing."
  exit 1
fi
echo "✓ Sensitive-content check passed"
