#!/usr/bin/env bash
# shellcheck shell=bash

# Shared plumbing for the CI wrappers around EAS CLI.
#
# EAS CLI serializes local build jobs -- including signing credentials -- into a base64
# child-process argument, so any EAS stdout/stderr that reaches the Actions log or the runner disk
# is a credential-disclosure risk. Every EAS invocation in CI therefore goes through
# `run_eas_privately`, and callers must discard or buffer its output in memory rather than echoing
# it. Source this file; do not execute it.

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

eas_ci_require_token() {
  local environment="$1"

  if [[ -z "${EXPO_TOKEN:-}" ]]; then
    echo "The $environment environment is missing EXPO_TOKEN." >&2
    exit 1
  fi
}

eas_ci_require_runner_paths() {
  : "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
  : "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
}

# App archives never leave runner.temp: they are not cached, not uploaded as workflow artifacts,
# and are deleted by the job's always-cleanup step.
eas_ci_require_temp_artifact() {
  case "$1" in
    "$RUNNER_TEMP"/*) ;;
    *)
      echo "The app archive must be inside RUNNER_TEMP." >&2
      exit 2
      ;;
  esac
}

eas_ci_verify_access() {
  if ! run_eas_privately whoami >/dev/null 2>&1; then
    echo "Expo token authentication failed. EAS output was withheld." >&2
    exit 1
  fi

  if ! run_eas_privately project:info >/dev/null 2>&1; then
    echo "Expo token cannot access the configured EAS project. EAS output was withheld." >&2
    exit 1
  fi
}

eas_ci_require_platform() {
  case "$1" in
    ios | android) ;;
    *)
      echo "Expected platform ios or android." >&2
      exit 2
      ;;
  esac
}
