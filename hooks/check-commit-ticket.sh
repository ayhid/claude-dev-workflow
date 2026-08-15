#!/usr/bin/env bash
# PreToolUse(Bash) guard: every git commit must reference an issue.
#
# Reads the hook payload on stdin, inspects only `git commit` invocations that
# carry an inline -m/--message, and blocks those whose subject is not a
# conventional commit referencing an issue ID.
#
# Exit 0 = allow. Exit 2 = block (stderr is surfaced to Claude).
# No network. Reads .dev-workflow.json when present for the escape hatch, the
# allowed types, the ID pattern and the required ID position; otherwise uses
# defaults matching a YouTrack project.
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
pattern='type(scope): description (ABC-123)'

# What an issue ID looks like, as a POSIX ERE — bash `=~`, `grep -E` and
# `sed -E` all use ERE, so no `\b`, no `\d`, no lookaround. Must stay in step
# with lib/issueid.mjs, which carries the same rule for the JavaScript side.
# The default is the YouTrack shape, so a project with no `commit.idPattern`
# behaves exactly as it did before this key existed.
id_re='[A-Z][A-Z0-9]*-[0-9]+'

# Must list the same names in the same order as CONFIG_FILES in lib/config.mjs.
# A test asserts the two lists have not drifted, which they have done before.
_find_cfg() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  dir=$(cd "$dir" 2>/dev/null && pwd) || return 1
  while [ -n "$dir" ]; do
    for rel in .dev-workflow.json .claude/dev-workflow.json; do
      [ -f "$dir/$rel" ] && { printf '%s' "$dir/$rel"; return 0; }
    done
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

  # An explicit idPattern wins; otherwise a github project gets the #123 shape.
  v=$(jq -r '.commit.idPattern // (if .provider == "github" then "#[0-9]+" else empty end)' "$cfg")
  [ -n "$v" ] && id_re="$v"
fi

# A bad regex would make every `[[ =~ ]]` below return non-zero, which turns
# this guard into a universal commit blocker — the worst possible failure for a
# hook that runs on every Bash call. grep exits 2 on an invalid pattern (1 just
# means no match), so this costs one process on the commit path and nothing at
# all elsewhere.
printf '' | grep -qE "$id_re" 2>/dev/null
if [ "$?" -gt 1 ]; then
  echo "check-commit-ticket: commit.idPattern is not a valid POSIX ERE ('$id_re') — using the default." >&2
  id_re='[A-Z][A-Z0-9]*-[0-9]+'
fi

# The pattern may legitimately contain '/' or '#' (GitHub IDs are '#123'), so
# the sed below is delimited with a comma. A pattern containing a comma would
# break that, and is rejected rather than silently mangled.
case "$id_re" in
  *,*)
    echo "check-commit-ticket: commit.idPattern may not contain a comma — using the default." >&2
    id_re='[A-Z][A-Z0-9]*-[0-9]+'
    ;;
esac

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
[[ "$subject" =~ $id_re ]] && has_ticket=1

# With the ID at the front, the conventional type sits after it — strip the
# prefix before looking for the type rather than demanding both at position 0.
typed_part="$subject"
if [ "$position" = "prefix" ]; then
  typed_part=$(printf '%s' "$subject" | sed -E "s,^(${id_re})[[:space:]]*:?[[:space:]]*,,")
fi

if [ "$require_type" -eq 0 ]; then
  has_type=1
else
  [[ "$typed_part" =~ ^($types)(\([a-zA-Z0-9_/-]+\))?!?:[[:space:]] ]] && has_type=1
fi

# Where the ID must sit. `suffix` is the common case: a bare `ABC-1: …` prefix
# is rejected by commitlint, so the ID goes at the end of the subject.
position_ok=1
if [ "$has_ticket" -eq 1 ]; then
  case "$position" in
    suffix) [[ "$subject" =~ ${id_re}\)?[[:space:]]*$ ]] || position_ok=0 ;;
    prefix) [[ "$subject" =~ ^${id_re} ]] || position_ok=0 ;;
    *)      : ;;   # "any" or anything unrecognised: position is not enforced
  esac
fi

if [ "$has_ticket" -eq 1 ] && [ "$has_type" -eq 1 ] && [ "$position_ok" -eq 1 ]; then
  exit 0
fi

{
  echo "BLOCKED: commit message must be a conventional commit that references an issue."
  echo "  got:      $subject"
  echo "  expected: $pattern"
  [ "$has_type" -eq 0 ]    && echo "  - missing or invalid conventional type; commitlint would reject this too"
  [ "$has_ticket" -eq 0 ]  && echo "  - no issue ID found (pattern $id_re)"
  [ "$position_ok" -eq 0 ] && echo "  - the issue ID must sit at the $position of the subject"
  echo "  escape hatch for genuinely ticketless work: $escape: ..."
} >&2
exit 2
