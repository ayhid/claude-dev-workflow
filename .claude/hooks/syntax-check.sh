#!/usr/bin/env bash
# PostToolUse(Edit|Write): parse-check the file that was just edited.
#
# Repo-local development tooling — this lives under .claude/ and is NOT part of
# the shipped plugin. It exists because 7ff735a was a syntax-level mistake that
# reached a release; a parse check costs milliseconds and catches that class
# the moment it is written rather than at the next manual run.
#
# Exit 0 = fine. Exit 2 = surface stderr back to Claude.
set -uo pipefail

input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null) || exit 0
[ -n "$file" ] && [ -f "$file" ] || exit 0

case "$file" in
  *.sh)
    out=$(bash -n "$file" 2>&1) || { printf 'Syntax error in %s:\n%s\n' "$file" "$out" >&2; exit 2; }
    if command -v shellcheck >/dev/null 2>&1; then
      out=$(shellcheck --external-sources --exclude=SC1091 "$file" 2>&1) \
        || { printf 'shellcheck findings in %s:\n%s\n' "$file" "$out" >&2; exit 2; }
    fi
    ;;
  *.mjs|*.js)
    out=$(node --check "$file" 2>&1) || { printf 'Syntax error in %s:\n%s\n' "$file" "$out" >&2; exit 2; }
    ;;
  *.json)
    out=$(jq -e . "$file" 2>&1 >/dev/null) || { printf 'Invalid JSON in %s:\n%s\n' "$file" "$out" >&2; exit 2; }
    ;;
esac

exit 0
