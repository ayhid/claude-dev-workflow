#!/usr/bin/env bash
# Shared config, token and HTTP plumbing for the yt-* scripts.
# Sourced, never executed directly.
#
# Config resolution, lowest precedence first:
#   1. built-in defaults
#   2. the nearest .youtrack.json (or .claude/youtrack.json) walking up from
#      $CLAUDE_PROJECT_DIR, else $PWD
#   3. environment variables (YOUTRACK_BASE_URL, YOUTRACK_PROJECT, …)
#
# The token is never written to disk and never appears in argv — curl reads the
# Authorization header from stdin via `-K -`.

yt_die()  { printf '%s: %s\n' "${YT_PROG:-yt}" "$*" >&2; exit 1; }
yt_warn() { printf '%s: %s\n' "${YT_PROG:-yt}" "$*" >&2; }

command -v jq   >/dev/null 2>&1 || yt_die "jq is required but not installed"
command -v curl >/dev/null 2>&1 || yt_die "curl is required but not installed"

# --- locate the config file --------------------------------------------------
yt_find_config() {
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

YT_CONFIG_FILE=$(yt_find_config || true)
if [ -n "${YT_CONFIG_FILE:-}" ]; then
  jq -e . "$YT_CONFIG_FILE" >/dev/null 2>&1 \
    || yt_die "$YT_CONFIG_FILE is not valid JSON"
fi

# yt_cfg <jq-path> [default] — read a value out of the config file.
yt_cfg() {
  local path="$1" default="${2:-}"
  [ -n "${YT_CONFIG_FILE:-}" ] || { printf '%s' "$default"; return 0; }
  local v
  v=$(jq -r "$path // empty" "$YT_CONFIG_FILE" 2>/dev/null)
  printf '%s' "${v:-$default}"
}

# --- effective settings ------------------------------------------------------
YOUTRACK_BASE_URL="${YOUTRACK_BASE_URL:-$(yt_cfg '.baseUrl')}"
YOUTRACK_PROJECT="${YOUTRACK_PROJECT:-$(yt_cfg '.project')}"
YOUTRACK_PROJECT_ID="${YOUTRACK_PROJECT_ID:-$(yt_cfg '.projectId')}"
YOUTRACK_TOKEN_OP_REF="${YOUTRACK_TOKEN_OP_REF:-$(yt_cfg '.tokenOpRef')}"

[ -n "$YOUTRACK_BASE_URL" ] || yt_die "no YouTrack URL configured — set YOUTRACK_BASE_URL or add \"baseUrl\" to .youtrack.json (run /yt-init)"
YOUTRACK_BASE_URL="${YOUTRACK_BASE_URL%/}"

# --- token -------------------------------------------------------------------
yt_resolve_token() {
  if [ -n "${YOUTRACK_TOKEN:-}" ]; then printf '%s' "$YOUTRACK_TOKEN"; return 0; fi
  [ -n "$YOUTRACK_TOKEN_OP_REF" ] || return 1
  command -v op >/dev/null 2>&1 || return 1
  op read "$YOUTRACK_TOKEN_OP_REF" 2>/dev/null
}

YT_TOKEN=$(yt_resolve_token) || true
[ -n "${YT_TOKEN:-}" ] || yt_die "no token available: set \$YOUTRACK_TOKEN, or configure \"tokenOpRef\" in .youtrack.json and sign in to 1Password"

# --- HTTP --------------------------------------------------------------------
# yt_curl <outfile> <curl args…> — prints the HTTP status, dies on transport error.
yt_curl() {
  local out="$1"; shift
  curl -sS -o "$out" -w '%{http_code}' \
    -H 'Accept: application/json' \
    "$@" -K - <<EOF || yt_die "network error contacting $YOUTRACK_BASE_URL"
header = "Authorization: Bearer $YT_TOKEN"
EOF
}

# yt_check_status <status> <body-file> <context>
yt_check_status() {
  case "$1" in
    200|201) return 0 ;;
    400)     yt_die "YouTrack rejected $3: $(jq -r '.error_description // .error // .' "$2" 2>/dev/null | head -c 300)" ;;
    401|403) yt_die "authentication failed (HTTP $1) — check the token and its permissions" ;;
    404)     yt_die "not found (HTTP 404): $3 at $YOUTRACK_BASE_URL" ;;
    *)       yt_die "YouTrack returned HTTP $1 for $3: $(head -c 300 "$2")" ;;
  esac
}

# yt_project_id — resolve the internal project id from the shortName, once.
yt_project_id() {
  if [ -n "$YOUTRACK_PROJECT_ID" ]; then printf '%s' "$YOUTRACK_PROJECT_ID"; return 0; fi
  [ -n "$YOUTRACK_PROJECT" ] || yt_die "no project configured — set YOUTRACK_PROJECT or add \"project\" to .youtrack.json"
  local b s id
  b=$(mktemp); trap 'rm -f "$b"' RETURN
  s=$(yt_curl "$b" --get --data-urlencode 'fields=id,shortName' "$YOUTRACK_BASE_URL/api/admin/projects")
  yt_check_status "$s" "$b" "the project list"
  id=$(jq -r --arg p "$YOUTRACK_PROJECT" '[.[] | select(.shortName == $p) | .id] | first // empty' "$b")
  [ -n "$id" ] || yt_die "project '$YOUTRACK_PROJECT' not found at $YOUTRACK_BASE_URL (visible: $(jq -r '[.[].shortName] | join(", ")' "$b"))"
  printf '%s' "$id"
}

# yt_state <issue-id> — current State field value, or "unknown".
yt_state() {
  local b s; b=$(mktemp); trap 'rm -f "$b"' RETURN
  s=$(yt_curl "$b" --get --data-urlencode 'fields=customFields(name,value(name))' \
        "$YOUTRACK_BASE_URL/api/issues/$1")
  [ "$s" = "200" ] || { printf 'unknown'; return 0; }
  jq -r '[.customFields[]? | select(.name=="State") | .value.name] | first // "unknown"' "$b"
}
