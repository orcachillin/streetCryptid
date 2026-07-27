#!/usr/bin/env bash

# Post one combined build notification for a PR into a per-PR Discord forum
# thread. The build jobs upload each platform and hand their install URLs here
# (masked); this runs once per commit in the notify job and posts a single
# reply listing both platforms.
#
# Thread lifecycle:
#   - DISCORD_THREAD_ID empty  -> create the PR's forum thread (webhook
#     thread_name; the channel MUST be a Discord Forum channel) and reply into it.
#   - DISCORD_THREAD_ID set     -> reply into that existing thread.
# The resulting thread id is written to DISCORD_THREAD_ID_OUT so the caller can
# persist it (a hidden marker on the PR status comment) and reuse it next commit.
#
# Public-repo hygiene: install URLs are registered as log masks and only ever
# sent to Discord; nothing prints the URLs, the webhook, or the internal host.
#
# Required env: DISCORD_WEBHOOK_URL, PR_NUMBER
# Optional env: DISCORD_THREAD_ID, DISCORD_THREAD_ID_OUT, PR_TITLE, PR_URL,
#   COMMIT_SHA, IOS_RESULT, IOS_URL, ANDROID_RESULT, ANDROID_URL

set -euo pipefail
umask 077

: "${DISCORD_WEBHOOK_URL:?DISCORD_WEBHOOK_URL must be set}"
: "${PR_NUMBER:?PR_NUMBER must be set}"

mask() {
  [[ -n "${GITHUB_ACTIONS:-}" && -n "${1:-}" ]] && echo "::add-mask::$1" || true
}

# Mask the install URLs (and their host prefix) before anything else runs.
for url in "${IOS_URL:-}" "${ANDROID_URL:-}"; do
  [[ -z "$url" ]] && continue
  mask "$url"
  host="${url#*://}"
  host="${host%%/*}"
  mask "$host"
done

# Build one platform line: a markdown install link on success, a failure note
# otherwise.
platform_line() {
  local emoji="$1" name="$2" result="$3" url="$4"
  if [[ "$result" == "success" && -n "$url" ]]; then
    printf '%s **%s** — [install](%s)' "$emoji" "$name" "$url"
  else
    printf '%s **%s** — ❌ build failed' "$emoji" "$name"
  fi
}

short_sha="${COMMIT_SHA:0:7}"
reply="$(
  if [[ -n "$short_sha" ]]; then
    printf '**Build `%s`**\n' "$short_sha"
  else
    printf '**New build**\n'
  fi
  platform_line '🍎' 'iOS' "${IOS_RESULT:-}" "${IOS_URL:-}"
  printf '\n'
  platform_line '🤖' 'Android' "${ANDROID_RESULT:-}" "${ANDROID_URL:-}"
)"

post() {
  # post <url>  — JSON payload is read from stdin (robust across platforms and
  # safe for UTF-8), and curl is kept quiet so nothing can echo a URL.
  curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data-binary @- \
    "$1"
}

thread_id="${DISCORD_THREAD_ID:-}"

if [[ -z "$thread_id" ]]; then
  # Create the PR's forum thread. thread_name is capped at 100 chars by Discord.
  title="${PR_TITLE:-}"
  thread_name="PR #${PR_NUMBER}"
  [[ -n "$title" ]] && thread_name="PR #${PR_NUMBER}: ${title}"
  thread_name="${thread_name:0:100}"

  root="$(
    printf '🏗️ **Builds for PR #%s**' "$PR_NUMBER"
    [[ -n "${PR_URL:-}" ]] && printf '\n%s' "$PR_URL"
  )"

  create_payload="$(jq -nc --arg name "$thread_name" --arg content "$root" \
    '{thread_name: $name, content: $content}')"

  if ! response="$(printf '%s' "$create_payload" | post "${DISCORD_WEBHOOK_URL}?wait=true" 2>/dev/null)"; then
    echo "Failed to create the Discord forum thread (is the channel a Forum channel?)." >&2
    exit 1
  fi

  thread_id="$(printf '%s' "$response" | jq -r '.channel_id // empty' 2>/dev/null || true)"
  if [[ -z "$thread_id" ]]; then
    echo "Discord did not return a thread id (is the webhook channel a Forum channel?)." >&2
    exit 1
  fi
fi

reply_payload="$(jq -nc --arg content "$reply" '{content: $content}')"
if ! printf '%s' "$reply_payload" | post "${DISCORD_WEBHOOK_URL}?thread_id=${thread_id}" >/dev/null 2>&1; then
  echo "Failed to post the build reply into the Discord thread." >&2
  exit 1
fi

# Hand the thread id back for persistence (it is a channel snowflake, not a
# secret, but it is never printed to keep the logs clean).
if [[ -n "${DISCORD_THREAD_ID_OUT:-}" ]]; then
  printf '%s' "$thread_id" > "$DISCORD_THREAD_ID_OUT"
fi

echo "Posted the build notification to the PR thread."
