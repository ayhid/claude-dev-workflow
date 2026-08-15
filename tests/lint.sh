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
# Husky hooks carry no extension, so the *.sh sweep would skip them and our own
# commit gate would be the one shell script nothing parses.
#
# `.husky/_/` is husky's own vendored runtime, written by `npm install` and
# ignored by a .gitignore husky puts there itself. It is not in the repo, it is
# not ours to fix, and linting it means CI fails on a dependency's style — which
# is exactly what it did, since a bare checkout has no `.husky/_/` and only CI
# ever saw the file.
while IFS= read -r f; do sh_files+=("$f"); done < <(
  { find . -name '*.sh' -not -path './node_modules/*' -not -path './.git/*' -not -path './.husky/_/*'
    find .husky -maxdepth 1 -type f -not -name '.*' 2>/dev/null; } | sort)
while IFS= read -r f; do js_files+=("$f"); done < <(
  find . -name '*.mjs' -not -path './node_modules/*' -not -path './.git/*' -not -path './.husky/_/*' | sort)

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
  shellcheck --external-sources --exclude=SC1091 "${sh_files[@]}" || status=1
else
  note "shellcheck: not installed, skipped"
fi

[ "$status" -eq 0 ] && note "lint: clean"
exit "$status"
