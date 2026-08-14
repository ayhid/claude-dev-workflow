#!/usr/bin/env bash
# Print the effective workflow config so a skill can read it in one call.
#
#   usage: yt-config.sh          # human-readable summary
#          yt-config.sh --json   # merged JSON, defaults filled in
#
# Every field has a default, so this succeeds even with no .youtrack.json —
# except baseUrl, which has none and is reported as missing.
set -euo pipefail
YT_PROG=yt-config

# Config location must work before yt-lib's token check, so replicate the walk.
_find() {
  local dir="${YOUTRACK_CONFIG_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"
  dir=$(cd "$dir" 2>/dev/null && pwd) || return 1
  while [ -n "$dir" ]; do
    [ -f "$dir/.youtrack.json" ]        && { printf '%s' "$dir/.youtrack.json"; return 0; }
    [ -f "$dir/.claude/youtrack.json" ] && { printf '%s' "$dir/.claude/youtrack.json"; return 0; }
    [ "$dir" = "/" ] && break
    dir=$(dirname "$dir")
  done
  return 1
}

cfg_file=$(_find || true)
if [ -n "$cfg_file" ]; then
  jq -e . "$cfg_file" >/dev/null 2>&1 || { echo "yt-config: $cfg_file is not valid JSON" >&2; exit 1; }
  user=$(cat "$cfg_file")
else
  user='{}'
fi

defaults='{
  "baseUrl": null,
  "project": null,
  "projectId": null,
  "tokenOpRef": null,
  "language": "English",
  "states": {
    "start": "In Progress",
    "review": "In Review",
    "done": "Done",
    "ladder": []
  },
  "branch": { "pattern": "<ID>-<slug>", "base": "main" },
  "commit": {
    "pattern": "type(scope): description (<ID>)",
    "position": "suffix",
    "noTicketEscape": "chore(no-ticket)",
    "types": ["feat","fix","docs","style","refactor","test","chore","perf","ci","revert","build"],
    "scopes": []
  },
  "issueTypes": ["Bug","Feature","Task","Epic","Improvement"],
  "priorities": ["Show-stopper","Critical","Major","Normal","Minor"],
  "defaultPriority": "Normal",
  "reviewer": null,
  "repos": []
}'

merged=$(jq -n --argjson d "$defaults" --argjson u "$user" '
  def deepmerge($a; $b):
    reduce ($b | to_entries[]) as $e
      ($a; if ($e.value | type) == "object" and (($a[$e.key] // null) | type) == "object"
           then .[$e.key] = deepmerge($a[$e.key]; $e.value)
           else .[$e.key] = $e.value end);
  deepmerge($d; $u)')

# Environment always wins.
merged=$(printf '%s' "$merged" | jq \
  --arg url "${YOUTRACK_BASE_URL:-}" \
  --arg proj "${YOUTRACK_PROJECT:-}" \
  --arg lang "${YOUTRACK_LANGUAGE:-}" '
  (if $url  != "" then .baseUrl  = $url  else . end)
  | (if $proj != "" then .project = $proj else . end)
  | (if $lang != "" then .language = $lang else . end)')

if [ "${1:-}" = "--json" ]; then
  printf '%s\n' "$merged"
  exit 0
fi

printf '%s\n' "$merged" | jq -r --arg f "${cfg_file:-<none — using defaults>}" '
  "config file: \($f)",
  "instance:    \(.baseUrl // "MISSING — run /yt-init")",
  "project:     \(.project // "MISSING — run /yt-init")",
  "language:    \(.language)",
  "states:      start=\(.states.start)  review=\(.states.review)  done=\(.states.done)"
    + (if (.states.ladder | length) > 0 then "\n             ladder: " + (.states.ladder | join(" → ")) else "" end),
  "branch:      \(.branch.pattern)  (base: \(.branch.base))",
  "commit:      \(.commit.pattern)   escape: \(.commit.noTicketEscape): …",
  "  types:     \(.commit.types | join(", "))"
    + (if (.commit.scopes | length) > 0 then "\n  scopes:    " + (.commit.scopes | join(", ")) else "" end),
  "reviewer:    \(.reviewer // "(none configured)")",
  "",
  "repos:",
  (if (.repos | length) == 0 then "  (none configured — treat the project as a single repo at its root)"
   else (.repos[] |
     "  - \(.path)"
     + (if .when   then "\n      routes: \(.when)" else "" end)
     + (if .checks then "\n      checks: " + (.checks | join(" && ")) else "" end)
     + (if .scopes then "\n      scopes: " + (.scopes | join(", ")) else "" end)
     + (if .env    then "\n      env:    " + (.env | to_entries | map("\(.key)=\(.value)") | join(" ")) else "" end)
     + (if .remotes then "\n      push:   " + (.remotes | join(", ")) else "" end))
   end),
  "",
  "notes:",
  (if .notes then (.notes[]? // .notes | "  - \(.)") else "  (none)" end)'
