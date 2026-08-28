#!/usr/bin/env bash
# PreToolUse(Edit|Write) guard: an accepted decision record is superseded, never edited.
#
# An ADR records what was known and decided at a moment. Editing an accepted one
# rewrites that moment, and every citation of its number then points at
# reasoning nobody actually had. The replacement is `dev.mjs adr supersede`,
# which writes a new record and links the two in both directions.
#
# Exit 0 = allow. Exit 2 = block (stderr is surfaced to Claude).
#
# see docs/decisions/0001 — why this is a hook and not a command, and why Edit|Write
#
# Matcher is Edit|Write, not Bash. The commit hook runs on every Bash call and
# is built around a ~3ms bail for that reason; this one runs only on file
# writes, which are rare by comparison, so it can afford to read the target.
# The cost of that choice is a known gap: an ADR rewritten through `sed -i` or a
# shell heredoc is not seen here. Closing it would mean a Bash arm and the
# latency budget that comes with one — a decision to take when it has actually
# happened, not before.
#
# `dev.mjs adr` writes through node's fs, not through the Edit tool, so the
# supersede path is unaffected by this guard. That is deliberate: the tool that
# knows the rule is allowed to write; the tool that does not, is not.
set -uo pipefail

input=$(cat)

# Without jq this hook cannot parse its payload and enforcement silently
# disappears. Blocking every write would be far worse, so allow — but say so,
# and only when something ADR-shaped is actually in flight, matching how
# check-commit-ticket.sh degrades.
if ! command -v jq >/dev/null 2>&1; then
  case "$input" in
    *decisions*|*[0-9][0-9][0-9][0-9]-*.md*)
      echo "check-adr-immutable: jq is not installed, so decision records are NOT protected. Install jq to restore the guard." >&2
      ;;
  esac
  exit 0
fi

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null) || exit 0
[ -n "$path" ] || exit 0

# Fast bail: not an ADR filename. `0007-worktrees.md`, not `README.md`.
base=${path##*/}
[[ "$base" =~ ^[0-9]+-.*\.md$ ]] || exit 0

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

decisions_dir='docs/decisions'
project_root="${CLAUDE_PROJECT_DIR:-$PWD}"

if cfg=$(_find_cfg) && jq -e . "$cfg" >/dev/null 2>&1; then
  project_root=$(dirname "$cfg")
  # Hook disabled outright. `// true` would be wrong: jq's alternative operator
  # treats `false` as empty, so an explicit false would read as true.
  [ "$(jq -r 'if .docs.enforce == false then "off" else "on" end' "$cfg")" = "off" ] && exit 0
  v=$(jq -r '.docs.decisionsDir // empty' "$cfg"); [ -n "$v" ] && decisions_dir="$v"
fi

# An absolute decisionsDir is used as-is; a relative one hangs off the project.
case "$decisions_dir" in
  /*) abs_dir="$decisions_dir" ;;
  *)  abs_dir="$project_root/$decisions_dir" ;;
esac

# Normalise both sides before comparing, so `docs/./decisions` and a symlinked
# project root do not read as different trees. A directory that does not exist
# yet cannot contain the file, and the prefix test below simply fails.
[ -d "$abs_dir" ] && abs_dir=$(cd "$abs_dir" 2>/dev/null && pwd)
file_dir=${path%/*}
[ -d "$file_dir" ] && file_dir=$(cd "$file_dir" 2>/dev/null && pwd)

# Outside the configured decisions directory: not ours to police. A file named
# `0001-notes.md` elsewhere in the repo is somebody else's convention.
[ "$file_dir" = "$abs_dir" ] || exit 0

# A file that does not exist yet is being created, and a record that does not
# exist cannot be history.
[ -f "$path" ] || exit 0

# Only `accepted` is frozen. `proposed` is still being written — which is the
# whole point of `adr new` scaffolding a proposed record — and `rejected` and
# `superseded` are terminal states this guard leaves to the command.
grep -qiE '^-[[:space:]]+Status:[[:space:]]+accepted[[:space:]]*$' "$path" || exit 0

number=$(printf '%s' "$base" | sed -E 's/^0*([0-9]+)-.*/\1/')

{
  echo "BLOCKED: $base is an accepted decision record and must not be edited."
  echo "  An ADR records what was decided at a moment. Editing it rewrites that"
  echo "  moment, and every citation of ${number} then points at reasoning nobody had."
  echo
  echo "  To change the decision, supersede it — this writes a new record and"
  echo "  links the two in both directions:"
  echo
  echo "      dev.mjs adr supersede ${number} \"<the new decision>\""
  echo
  echo "  To correct a typo, the record has to be reopened deliberately:"
  echo "      dev.mjs adr reject ${number}   # or edit the status line by hand"
} >&2
exit 2
