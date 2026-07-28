#!/usr/bin/env bash

# Write a released version into app.json (`expo.version`) and package.json (`version`).
#
# Both files are Prettier-formatted and hand-maintained, so this rewrites the single version line
# in place instead of reserializing the JSON, which would reflow unrelated keys.
#
# Usage: scripts/apply-version.sh <x.y.z>

set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: apply-version.sh <MAJOR.MINOR.PATCH>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rewrite() {
  local file="$1"
  SC_RELEASE_VERSION="$version" perl -pi -e '
    if (!$done && s/^(\s*"version":\s*")\d+\.\d+\.\d+("\,?)$/$1$ENV{SC_RELEASE_VERSION}$2/) {
      $done = 1;
    }
  ' "$file"
}

rewrite "$repo_root/app.json"
rewrite "$repo_root/package.json"

if [[ "$(jq -er '.expo.version | strings' "$repo_root/app.json")" != "$version" ]]; then
  echo "Failed to set expo.version in app.json." >&2
  exit 1
fi
if [[ "$(jq -er '.version | strings' "$repo_root/package.json")" != "$version" ]]; then
  echo "Failed to set version in package.json." >&2
  exit 1
fi

printf 'Set the app version to %s.\n' "$version"
