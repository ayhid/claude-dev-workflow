#!/usr/bin/env bash
# Fetch a YouTrack issue and print it as clean markdown.
#
#   usage: yt-fetch.sh RMB-22
#
# Config comes from .youtrack.json / env — see yt-lib.sh.
set -euo pipefail
YT_PROG=yt-fetch
. "$(dirname "${BASH_SOURCE[0]}")/yt-lib.sh"

[ $# -ge 1 ] || yt_die "usage: yt-fetch.sh <ISSUE-ID>   (e.g. RMB-22)"
issue="$1"

fields='idReadable,summary,description,customFields(name,value(name,login,fullName,presentation,text,minutes)),comments(text,created,author(login,fullName))'

body=$(mktemp)
trap 'rm -f "$body"' EXIT

status=$(yt_curl "$body" --get --data-urlencode "fields=$fields" \
  "$YOUTRACK_BASE_URL/api/issues/$issue")
yt_check_status "$status" "$body" "issue '$issue'"

jq -er '
  def val:
    if . == null then "—"
    elif type == "array" then (if length == 0 then "—" else (map(val) | join(", ")) end)
    elif type == "object" then
      (.name // .fullName // .login // .presentation // .text
       // (if .minutes then (.minutes | tostring) + "m" else null end) // "—")
    else tostring end;

  def field($n): (.customFields // []) | map(select(.name == $n)) | first | .value | val;
  def ts: if . then (. / 1000 | floor | gmtime | strftime("%Y-%m-%d %H:%M UTC")) else "unknown date" end;

  "# \(.idReadable) — \(.summary // "(no title)")",
  "",
  "**State:** \(field("State"))  |  **Assignee:** \(field("Assignee"))",
  "",
  "## Description",
  "",
  ((.description // "") | if . == "" then "_(no description)_" else . end),
  "",
  "## Fields",
  "",
  ((.customFields // [])
    | map(select(.name != "State" and .name != "Assignee"))
    | map({name, v: (.value | val)}) | map(select(.v != "—"))
    | map("- **\(.name):** \(.v)")
    | if length == 0 then ["_(no other fields set)_"] else . end
    | .[]),
  "",
  "## Comments (\((.comments // []) | length))",
  "",
  ((.comments // [])
    | if length == 0 then ["_(no comments)_"]
      else map("### @\(.author.login // "unknown") — \(.created | ts)\n\n\(.text // "")\n")
      end
    | .[])
' "$body" || yt_die "unexpected API response shape (could not render issue $issue)"
