#!/usr/bin/env bash

# Build a standalone app archive locally on the CI runner with `eas build
# --local` (no EAS cloud build credits consumed). The finished .ipa/.apk is left
# at $artifact; publishing it to the internal distribution server is a separate
# step (scripts/upload-build.sh), so this script never touches the network
# beyond the credential fetch EAS needs to sign the build.

set -euo pipefail
umask 077

platform="${1:-}"
profile="${2:-}"
artifact="${3:-}"

case "$platform" in
  ios | android) ;;
  *)
    echo "Expected platform ios or android." >&2
    exit 2
    ;;
esac

if [[ -z "$profile" || -z "$artifact" ]]; then
  echo "Usage: eas-local-build-ci.sh <ios|android> <profile> <artifact>" >&2
  exit 2
fi

if [[ -z "${EXPO_TOKEN:-}" ]]; then
  echo "The development-builds environment is missing EXPO_TOKEN." >&2
  exit 1
fi

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

case "$artifact" in
  "$RUNNER_TEMP"/*) ;;
  *)
    echo "The app archive must be inside RUNNER_TEMP." >&2
    exit 2
    ;;
esac

run_eas_privately() {
  env \
    -u DEBUG \
    -u EAS_DEBUG \
    -u EXPO_DEBUG \
    -u GITHUB_ENV \
    -u GITHUB_PATH \
    -u GITHUB_STATE \
    -u GITHUB_STEP_SUMMARY \
    -u GITHUB_OUTPUT \
    EAS_LOCAL_BUILD_LOGGER_LEVEL=error \
    eas "$@"
}

if ! run_eas_privately whoami >/dev/null 2>&1; then
  echo "Expo token authentication failed. EAS output was withheld." >&2
  exit 1
fi

if ! run_eas_privately project:info >/dev/null 2>&1; then
  echo "Expo token cannot access the configured EAS project. EAS output was withheld." >&2
  exit 1
fi

if ! run_eas_privately build \
  --local \
  --platform "$platform" \
  --profile "$profile" \
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

echo "Local $platform build complete."
