#!/usr/bin/env bash

# Build a production app archive on this runner and hand it to EAS Submit.
#
# The binary is produced by `eas build --local`, so no EAS cloud build quota is consumed and the
# signing credentials come from the EAS remote store rather than GitHub secrets. Only the finished
# archive goes to Expo, where EAS Submit forwards it to App Store Connect (TestFlight) or the
# Google Play internal track.
#
# Usage: eas-local-release-ci.sh <ios|android> <build profile> <submit profile> <artifact>
#
# Optional environment:
#   SC_WHAT_TO_TEST  release notes shown to TestFlight testers (iOS only).

set -euo pipefail
umask 077

# shellcheck source=scripts/eas-ci-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/eas-ci-common.sh"

platform="${1:-}"
build_profile="${2:-}"
submit_profile="${3:-}"
artifact="${4:-}"

eas_ci_require_platform "$platform"

if [[ -z "$build_profile" || -z "$submit_profile" || -z "$artifact" ]]; then
  echo "Usage: eas-local-release-ci.sh <ios|android> <build profile> <submit profile> <artifact>" >&2
  exit 2
fi

eas_ci_require_token production-release
eas_ci_require_runner_temp
eas_ci_require_output
eas_ci_require_temp_artifact "$artifact"
eas_ci_verify_access

if ! run_eas_privately build \
  --local \
  --platform "$platform" \
  --profile "$build_profile" \
  --output "$artifact" \
  --non-interactive \
  --freeze-credentials \
  >/dev/null 2>&1; then
  echo "EAS local $platform build failed. Expo output was withheld because it can contain signing credentials." >&2
  exit 1
fi

if [[ ! -f "$artifact" ]]; then
  echo "EAS local $platform build did not produce the expected app archive. Expo output was withheld." >&2
  exit 1
fi

submit_args=(
  submit
  --platform "$platform"
  --profile "$submit_profile"
  --path "$artifact"
  --non-interactive
  --wait
)
# App Store Connect rejects an over-long "What to Test", and it is only meaningful for TestFlight.
if [[ "$platform" == "ios" && -n "${SC_WHAT_TO_TEST:-}" ]]; then
  submit_args+=(--what-to-test "$(cut -c 1-3500 <<<"$SC_WHAT_TO_TEST")")
fi

# `eas submit` has no --json mode, so its output is buffered in memory and only an allow-listed
# submission URL is ever echoed.
if ! submit_output="$(run_eas_privately "${submit_args[@]}" 2>&1)"; then
  unset submit_output
  echo "EAS $platform submission failed. Expo output was withheld because it can contain store credentials." >&2
  exit 1
fi

submission_url_pattern='^https://expo\.dev/accounts/[A-Za-z0-9._-]+/projects/[A-Za-z0-9._-]+/submissions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
submission_url="$(
  grep -Eom1 \
    'https://expo\.dev/accounts/[A-Za-z0-9._-]+/projects/[A-Za-z0-9._-]+/submissions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    <<<"$submit_output" || true
)"
unset submit_output

if [[ -n "$submission_url" && "$submission_url" =~ $submission_url_pattern ]]; then
  printf 'submission_url=%s\n' "$submission_url" >> "$GITHUB_OUTPUT"
fi

printf 'Submitted the %s archive to the store.\n' "$platform"
