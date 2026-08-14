#!/usr/bin/env bash
# Apply a YouTrack command to an issue, optionally posting a comment.
#
#   usage: yt-update.sh RMB-22 "State In Progress"
#          yt-update.sh RMB-22 "State Staging" "Implemented X and Y. Tests green."
#          yt-update.sh RMB-22 "comment" @/tmp/comment.md
#
# The comment may be a literal string or @path to read a file (@@ escapes a
# literal '@'). Config comes from .youtrack.json / env — see yt-lib.sh.
set -euo pipefail
YT_PROG=yt-update
. "$(dirname "${BASH_SOURCE[0]}")/yt-lib.sh"

[ $# -ge 2 ] || yt_die 'usage: yt-update.sh <ISSUE-ID> <COMMAND> [COMMENT|@FILE]'
issue="$1"
cmd="$2"
comment="${3:-}"
[ -n "$cmd" ] || yt_die "command string must not be empty"

case "$comment" in
  @@*) comment="${comment#@}" ;;
  @*)  file="${comment#@}"
       [ -f "$file" ] || yt_die "comment file not found: $file"
       comment=$(cat "$file") ;;
esac

body=$(mktemp); req=$(mktemp)
trap 'rm -f "$body" "$req"' EXIT

# `comment` is not a YouTrack command — the commands API would 400 on it. Route
# comment-only updates to the dedicated endpoint instead.
if [ "$cmd" = "comment" ]; then
  [ -n "$comment" ] || yt_die "\"comment\" needs the comment text as the third argument"
  jq -n --arg t "$comment" '{text: $t, usesMarkdown: true}' > "$req"
  status=$(yt_curl "$body" -X POST -H 'Content-Type: application/json' \
    --data @"$req" "$YOUTRACK_BASE_URL/api/issues/$issue/comments?fields=id")
  yt_check_status "$status" "$body" "comment on $issue"
  printf 'yt-update: %s — comment posted (%d chars); State is: %s\n' \
    "$issue" "${#comment}" "$(yt_state "$issue")"
  exit 0
fi

payload=$(jq -n --arg q "$cmd" --arg id "$issue" --arg c "$comment" \
  '{query: $q, issues: [{idReadable: $id}], usesMarkdown: true}
   + (if $c == "" then {} else {comment: $c} end)')

printf '%s' "$payload" > "$req"

status=$(yt_curl "$body" -X POST -H 'Content-Type: application/json' \
  --data @"$req" "$YOUTRACK_BASE_URL/api/commands")
yt_check_status "$status" "$body" "command '$cmd' on $issue"

# The commands API can return 200 for a command it did not apply, so the POST
# status alone proves nothing — read the state back.
new_state=$(yt_state "$issue")

printf 'yt-update: %s — applied "%s"; State is now: %s\n' "$issue" "$cmd" "$new_state"
if [ -n "$comment" ]; then
  printf 'yt-update: comment posted (%d chars)\n' "${#comment}"
fi
