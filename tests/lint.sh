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

# Use a file rather than process substitution so inventory failures fail lint.
# Bash 3.2 supports read -d but has no mapfile; NUL preserves spaces/newlines.
inventory=$(mktemp) || exit 1
trap 'rm -f "$inventory"' EXIT
node tests/lint-inventory.mjs > "$inventory" || exit 1
sh_files=() js_files=()
while IFS= read -r -d '' f; do
  if [[ "$f" == *.sh || ( "$f" == ./.husky/* && "${f#./.husky/}" != */* ) ]]; then
    sh_files+=("$f")
  else
    js_files+=("$f")
  fi
done < "$inventory"

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
  # SC1091: sourced paths are resolved at runtime, not from this checkout.
  if [ "${#sh_files[@]}" -gt 0 ]; then
    shellcheck --external-sources --exclude=SC1091 "${sh_files[@]}" || status=1
  fi
else
  note "shellcheck: not installed, skipped"
fi

[ "$status" -eq 0 ] && note "lint: clean"
exit "$status"
