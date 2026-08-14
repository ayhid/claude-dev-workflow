#!/usr/bin/env bash
# Syntax gate for every script in the repo.
#
# `bash -n` and `node --check` are parse-only, so this is fast and needs no
# network — exactly the class of error that shipped in 7ff735a. shellcheck adds
# real analysis on top and runs when it is installed; CI always installs it.
#
#   usage: tests/lint.sh
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1

status=0
note() { printf '%s\n' "$*"; }

# Portable collection: macOS still ships bash 3.2, which has no `mapfile`.
sh_files=() js_files=()
while IFS= read -r f; do sh_files+=("$f"); done < <(
  find . -name '*.sh' -not -path './node_modules/*' -not -path './.git/*' | sort)
while IFS= read -r f; do js_files+=("$f"); done < <(
  find . -name '*.mjs' -not -path './node_modules/*' -not -path './.git/*' | sort)

note "bash -n (${#sh_files[@]} files)"
for f in "${sh_files[@]}"; do
  bash -n "$f" || { note "  FAIL $f"; status=1; }
done

note "node --check (${#js_files[@]} files)"
for f in "${js_files[@]}"; do
  node --check "$f" >/dev/null || { note "  FAIL $f"; status=1; }
done

if command -v shellcheck >/dev/null 2>&1; then
  note "shellcheck (${#sh_files[@]} files)"
  # SC1091: sourced files are resolved at runtime from $CLAUDE_PLUGIN_ROOT.
  shellcheck --external-sources --exclude=SC1091 "${sh_files[@]}" || status=1
else
  note "shellcheck: not installed, skipped"
fi

[ "$status" -eq 0 ] && note "lint: clean"
exit "$status"
