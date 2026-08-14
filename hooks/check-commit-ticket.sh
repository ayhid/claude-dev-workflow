#!/usr/bin/env bash
# PreToolUse(Bash) guard: every git commit must reference a YouTrack issue.
#
# Reads the hook payload on stdin, inspects only `git commit` invocations that
# carry an inline -m/--message, and blocks those whose subject is not a
# conventional commit referencing an issue ID.
#
# Exit 0 = allow. Exit 2 = block (stderr is surfaced to Claude).
# No network. Reads .youtrack.json when present for the escape hatch, the
# allowed types and the required ID position; otherwise uses defaults.
set -uo pipefail

input=$(cat)

# Without jq this hook cannot parse its own payload, and enforcement silently
# disappears — the worst failure mode for a guard. Blocking every Bash call
# would be worse still, so allow, but say so, and only when a commit is
# actually in flight: a crude match on the raw payload is enough to tell.
if ! command -v jq >/dev/null 2>&1; then
  case "$input" in
    *"git commit"*)
      echo "check-commit-ticket: jq is not installed, so the commit-message convention is NOT being enforced. Install jq to restore it." >&2
      ;;
  esac
  exit 0
fi

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# Fast bail: not a git commit at all.
[[ "$cmd" =~ (^|[\;\&\|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$) ]] || exit 0

# No inline message (editor, -F file, --amend --no-edit): defer to husky/commitlint.
[[ "$cmd" =~ (^|[[:space:]])(-m|--message)([[:space:]]|=) ]] || exit 0

# --- config ------------------------------------------------------------------
escape='chore(no-ticket)'
types='feat|fix|docs|style|refactor|test|chore|perf|ci|revert|build'
position='suffix'
pattern='type(scope): description (RMB-123)'

_find_cfg() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  dir=$(cd "$dir" 2>/dev/null && pwd) || return 1
  while [ -n "$dir" ]; do
    [ -f "$dir/.youtrack.json" ]        && { printf '%s' "$dir/.youtrack.json"; return 0; }
    [ -f "$dir/.claude/youtrack.json" ] && { printf '%s' "$dir/.claude/youtrack.json"; return 0; }
    [ "$dir" = "/" ] && break
    dir=$(dirname "$dir")
  done
  return 1
}

require_type=1

if command -v jq >/dev/null 2>&1 && cfg=$(_find_cfg) && jq -e . "$cfg" >/dev/null 2>&1; then
  # Hook disabled outright. `// true` would be wrong here — jq's alternative
  # operator treats `false` as empty, so an explicit false would read as true.
  [ "$(jq -r 'if .commit.enforce == false then "off" else "on" end' "$cfg")" = "off" ] && exit 0
  [ "$(jq -r 'if .commit.requireType == false then "off" else "on" end' "$cfg")" = "off" ] && require_type=0
  v=$(jq -r '.commit.noTicketEscape // empty' "$cfg"); [ -n "$v" ] && escape="$v"
  v=$(jq -r '(.commit.types // []) | join("|")' "$cfg"); [ -n "$v" ] && types="$v"
  v=$(jq -r '.commit.position // empty' "$cfg");        [ -n "$v" ] && position="$v"
  v=$(jq -r '.commit.pattern // empty' "$cfg");         [ -n "$v" ] && pattern="$v"
fi

# --- extract the subject line ------------------------------------------------
# Flatten newlines first: git commit -m "subject\n\nbody" is one shell word, but
# grep is line-oriented and would truncate the match mid-quote.
flat=$(printf '%s' "$cmd" | tr '\n' '\001')

subject=$(printf '%s' "$flat" \
  | grep -oE -- '(-m|--message)[=[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)' \
  | head -1 \
  | sed -E 's/^(-m|--message)[=[:space:]]+//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')

# Only the subject line is validated; drop the body.
subject="${subject%%$'\001'*}"
# Defensive: strip an unbalanced leading quote if the message was still truncated.
subject="${subject#\"}"
subject="${subject#\'}"

# Unparseable message: defer rather than guess.
[ -n "$subject" ] || exit 0

# Escape hatch for genuinely ticketless work.
case "$subject" in
  "$escape":*) exit 0 ;;
esac

has_ticket=0
has_type=0
[[ "$subject" =~ [A-Z][A-Z0-9]*-[0-9]+ ]] && has_ticket=1

# With the ID at the front, the conventional type sits after it — strip the
# prefix before looking for the type rather than demanding both at position 0.
typed_part="$subject"
if [ "$position" = "prefix" ]; then
  typed_part=$(printf '%s' "$subject" | sed -E 's/^[A-Z][A-Z0-9]*-[0-9]+[[:space:]]*:?[[:space:]]*//')
fi

if [ "$require_type" -eq 0 ]; then
  has_type=1
else
  [[ "$typed_part" =~ ^($types)(\([a-zA-Z0-9_/-]+\))?!?:[[:space:]] ]] && has_type=1
fi

# Where the ID must sit. `suffix` is the common case: a bare `RMB-1: …` prefix
# is rejected by commitlint, so the ID goes at the end of the subject.
position_ok=1
if [ "$has_ticket" -eq 1 ]; then
  case "$position" in
    suffix) [[ "$subject" =~ [A-Z][A-Z0-9]*-[0-9]+\)?[[:space:]]*$ ]] || position_ok=0 ;;
    prefix) [[ "$subject" =~ ^[A-Z][A-Z0-9]*-[0-9]+ ]] || position_ok=0 ;;
    *)      : ;;   # "any" or anything unrecognised: position is not enforced
  esac
fi

if [ "$has_ticket" -eq 1 ] && [ "$has_type" -eq 1 ] && [ "$position_ok" -eq 1 ]; then
  exit 0
fi

{
  echo "BLOCKED: commit message must be a conventional commit that references a YouTrack issue."
  echo "  got:      $subject"
  echo "  expected: $pattern"
  [ "$has_type" -eq 0 ]    && echo "  - missing or invalid conventional type; commitlint would reject this too"
  [ "$has_ticket" -eq 0 ]  && echo "  - no issue ID found (pattern [A-Z][A-Z0-9]*-[0-9]+)"
  [ "$position_ok" -eq 0 ] && echo "  - the issue ID must sit at the $position of the subject"
  echo "  escape hatch for genuinely ticketless work: $escape: ..."
} >&2
exit 2
