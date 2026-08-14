#!/usr/bin/env bash
# Create a YouTrack issue and print its ID, or search for likely duplicates.
#
#   usage: yt-create.sh "<summary>" "<description>" [TYPE] [PRIORITY]
#          yt-create.sh "Router: 500 on nested slug" @/tmp/body.md Bug Major
#          yt-create.sh --dup-check "redirect 500 slug"
#
# The description may be a literal string (multiline is fine) or @path to read a
# file. A leading @@ escapes to a literal '@'. On success ONLY the issue ID is
# printed to stdout, so callers can capture it; everything else goes to stderr.
#
# Config comes from .youtrack.json / env — see yt-lib.sh.
set -euo pipefail
YT_PROG=yt-create
. "$(dirname "${BASH_SOURCE[0]}")/yt-lib.sh"

body=$(mktemp); req=$(mktemp)
trap 'rm -f "$body" "$req"' EXIT

# --- duplicate check ---------------------------------------------------------
# Runs before drafting a new issue. Lives here rather than in the skill so the
# token logic stays in one place and never reaches a command line.
if [ "${1:-}" = "--dup-check" ]; then
  [ $# -ge 2 ] && [ -n "$2" ] || yt_die 'usage: yt-create.sh --dup-check "<keywords>"'
  [ -n "$YOUTRACK_PROJECT" ] || yt_die "no project configured — set YOUTRACK_PROJECT or add \"project\" to .youtrack.json"

  status=$(yt_curl "$body" --get \
    --data-urlencode "query=project: $YOUTRACK_PROJECT #Unresolved $2" \
    --data-urlencode 'fields=idReadable,summary' \
    --data-urlencode '$top=15' \
    "$YOUTRACK_BASE_URL/api/issues")
  yt_check_status "$status" "$body" "the issue search"

  jq -er 'if length == 0 then "no open issues matched"
          else (.[] | "\(.idReadable)\t\(.summary // "(no title)")") end' "$body" \
    || yt_die "unexpected API response shape from the issue search"
  exit 0
fi

# --- create ------------------------------------------------------------------
[ $# -ge 2 ] || yt_die 'usage: yt-create.sh "<summary>" "<description>" [TYPE] [PRIORITY]'
summary="$1"
description="$2"
type="${3:-Bug}"
priority="${4:-}"
[ -n "$summary" ] || yt_die "summary must not be empty"

case "$description" in
  @@*) description="${description#@}" ;;
  @*)  file="${description#@}"
       [ -f "$file" ] || yt_die "description file not found: $file"
       description=$(cat "$file") ;;
esac

project_id=$(yt_project_id)

jq -n --arg p "$project_id" --arg s "$summary" --arg d "$description" \
  '{project: {id: $p}, summary: $s, description: $d, usesMarkdown: true}' > "$req"

status=$(yt_curl "$body" -X POST -H 'Content-Type: application/json' \
  --data @"$req" "$YOUTRACK_BASE_URL/api/issues?fields=idReadable")
yt_check_status "$status" "$body" "the new issue in project $YOUTRACK_PROJECT"

issue=$(jq -er '.idReadable' "$body" 2>/dev/null) \
  || yt_die "issue may have been created, but the response carried no idReadable: $(head -c 300 "$body")"

# --- set Type and Priority ---------------------------------------------------
# Custom field values via the issues endpoint need per-project field ids; the
# commands API takes them by name. Brace ONLY values containing a space: the
# parser is greedy inside braces, so `Type {Bug} Priority {Critical}` is read as
# the single value "{Bug} Priority" and 400s.
# The issue already exists by this point, so a failure here warns rather than
# dying — losing the ID would be worse than an unset field.
brace() { case "$1" in *" "*) printf '{%s}' "$1" ;; *) printf '%s' "$1" ;; esac; }

cmd="Type $(brace "$type")"
[ -n "$priority" ] && cmd="$cmd Priority $(brace "$priority")"

jq -n --arg q "$cmd" --arg id "$issue" '{query: $q, issues: [{idReadable: $id}]}' > "$req"

cmd_status=$(curl -sS -o "$body" -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  --data @"$req" "$YOUTRACK_BASE_URL/api/commands" -K - <<EOF || echo "000"
header = "Authorization: Bearer $YT_TOKEN"
EOF
)

if [ "$cmd_status" != "200" ]; then
  yt_warn "$issue was created, but applying '$cmd' failed (HTTP $cmd_status) — set Type/Priority by hand"
else
  # The commands API returns 200 for commands it did not apply; read back.
  yt_curl "$body" --get --data-urlencode 'fields=customFields(name,value(name))' \
    "$YOUTRACK_BASE_URL/api/issues/$issue" >/dev/null
  applied=$(jq -r '[.customFields[]? | select(.name=="Type" or .name=="Priority")
                    | "\(.name)=\(.value.name // "unset")"] | join(" ")' "$body")
  yt_warn "created $issue ($applied)"
fi

printf '%s\n' "$issue"
