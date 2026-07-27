#!/usr/bin/env bash

# Upload a locally-built app archive to the internal app-distribution server and
# expose the resulting install URL as a MASKED GitHub Actions step output
# (install_url). Posting to Discord happens later, once, in the notify job, so a
# single combined reply per commit can be threaded per PR.
#
# Public-repo hygiene: the base URL, its host, and the install URL are all
# registered as log masks; the URL is written only to $GITHUB_OUTPUT (which is
# not echoed to logs and not exposed via the public REST API), never printed.
#
# Usage: upload-build.sh <ios|android> <artifact>
# Required env: DISTRIBUTOR_BASE_URL, DISTRIBUTOR_TOKEN

set -euo pipefail
umask 077

platform="${1:-}"
artifact="${2:-}"

case "$platform" in
  ios | android) ;;
  *)
    echo "Expected platform ios or android." >&2
    exit 2
    ;;
esac

if [[ -z "$artifact" ]]; then
  echo "Usage: upload-build.sh <ios|android> <artifact>" >&2
  exit 2
fi

if [[ ! -f "$artifact" ]]; then
  echo "App archive not found: expected a built $platform artifact." >&2
  exit 1
fi

for var in DISTRIBUTOR_BASE_URL DISTRIBUTOR_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    echo "The development-builds environment is missing $var." >&2
    exit 1
  fi
done

# Redact the internal host everywhere it could surface, before any request runs.
base_url="${DISTRIBUTOR_BASE_URL%/}"
host="${base_url#*://}"
host="${host%%/*}"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::$base_url"
  echo "::add-mask::$host"
fi

# Upload. The plaintext response body is the install-page URL. Curl output is
# kept quiet so a verbose/error dump can't echo the host.
if ! install_url="$(
  curl --fail --silent --show-error \
    --header 'Accept: text/plain' \
    --header "X-Auth-Token: $DISTRIBUTOR_TOKEN" \
    --form "app_file=@${artifact}" \
    "$base_url/upload" 2>/dev/null
)"; then
  echo "Upload of the $platform build to the distribution server failed." >&2
  exit 1
fi

install_url="$(printf '%s' "$install_url" | tr -d '\r\n')"

# Mask the install URL immediately, then sanity-check its shape.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::$install_url"
fi

case "$install_url" in
  "$base_url"/get/*) ;;
  *)
    echo "The distribution server returned an unexpected response." >&2
    exit 1
    ;;
esac

# Hand the link forward via a step output. GitHub SCRUBS job outputs that
# contain a secret, and the full URL contains the (secret) base URL — so emit
# only the non-secret path (e.g. /get/<id>). The notify job rebuilds the full
# URL from DISTRIBUTOR_BASE_URL + this path. Deliberately NOT masked: a masked
# value would also be scrubbed from the output; the path is never printed to a
# log anyway (this step's output is suppressed, and it only lands in
# $GITHUB_OUTPUT, which is not echoed).
install_path="${install_url#"$base_url"}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'install_path=%s\n' "$install_path" >> "$GITHUB_OUTPUT"
fi

echo "Uploaded the $platform build."
