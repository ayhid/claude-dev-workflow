#!/usr/bin/env bash
# Table test for hooks/lint-edited-file.mjs.
#
# The hook lints the one file that was just written and hands the findings back
# to the model. Every case here asserts the two promises in its header.
#
# **It may never fail a session.** Every path but "there are findings" exits 0:
# no config, switched off, a file the linter does not handle, a linter that
# cannot start, a linter that errors without findings, a linter that hangs, a
# payload that is not JSON. Exit 2 is reserved for findings, because exit 2 is
# what puts stderr in front of the model.
#
# **It writes nothing.** One case snapshots the tree either side of a run.
#
# No real linter is ever spawned: `repos[].lintFile` points every case at a
# stub, which also pins that the configured command wins over the detected one.
#
#   usage: tests/lint-hook.test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$ROOT/hooks/lint-edited-file.mjs"
NODE_BIN="${NODE:-$(command -v node)}"

[ -f "$HOOK" ] || { echo "tests: no hook at $HOOK" >&2; exit 1; }

pass=0 fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A stub linter. $1 is the mode; every argument after it is what the hook passed.
make_stub() {
  local path="$1" mode="$2"
  cat > "$path" <<STUB
#!/usr/bin/env bash
case "$mode" in
  clean)   exit 0 ;;
  findings)
    printf '%s: line 3, col 1, Error - Unexpected throw (no-restricted-syntax)\n' "\$1"
    exit 1 ;;
  echoargs)
    printf 'argv:%s\n' "\$*"
    exit 1 ;;
  missing) exit 127 ;;
  broken)  printf 'Cannot read config\n' >&2; exit 2 ;;
  hang)    sleep 30; exit 0 ;;
  many)    for i in \$(seq 1 60); do printf 'line %s: something (a-rule)\n' "\$i"; done; exit 1 ;;
esac
STUB
  chmod +x "$path"
}

# build_project <dir> <config-json|--none> <stub-mode>
build_project() {
  local dir="$1" cfg="$2" mode="$3"
  mkdir -p "$dir/_dev-workflow/hooks" "$dir/src"
  ln -sf "$ROOT/lib" "$dir/_dev-workflow/lib"
  cp "$HOOK" "$dir/_dev-workflow/hooks/lint-edited-file.mjs"
  printf 'export const x = 1;\n' > "$dir/src/index.ts"
  printf '# notes\n' > "$dir/README.md"
  [ "$mode" = "--none" ] || make_stub "$dir/stub-linter" "$mode"
  [ "$cfg" = "--none" ] || printf '%s' "$cfg" > "$dir/.dev-workflow.json"
}

# run_case <desc> <expected-exit> <expected-stderr-substring|--silent> <config> <stub-mode> <edited-path>
run_case() {
  local desc="$1" want_code="$2" want="$3" cfg="$4" mode="$5" edited="$6"
  local dir="$TMP/case-$((pass + fail))"
  build_project "$dir" "$cfg" "$mode"

  local err code
  err=$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$dir/$edited" \
    | env CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" 2>&1 >/dev/null)
  code=$?

  if [ "$code" != "$want_code" ]; then
    printf 'FAIL  %s\n      exit %s, wanted %s\n      stderr: %s\n' "$desc" "$code" "$want_code" "$err"
    fail=$((fail + 1))
    return
  fi
  if [ "$want" = "--silent" ]; then
    if [ -n "$err" ]; then
      printf 'FAIL  %s\n      wanted silence, got: %s\n' "$desc" "$err"
      fail=$((fail + 1))
      return
    fi
  elif ! printf '%s' "$err" | grep -qF "$want"; then
    printf 'FAIL  %s\n      wanted %s in: %s\n' "$desc" "$want" "$err"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$desc"
  pass=$((pass + 1))
}

CFG() { printf '{"provider":"github","repos":[{"path":".","lintFile":["./stub-linter","<FILE>"]}]%s}' "${1:-}"; }

run_case 'findings reach the model, on stderr, with exit 2' \
  2 'no-restricted-syntax' "$(CFG)" findings src/index.ts

run_case 'a clean file says nothing at all' \
  0 --silent "$(CFG)" clean src/index.ts

run_case 'a file the linter does not handle is skipped in silence' \
  0 --silent "$(CFG)" findings README.md

run_case 'a linter that cannot start is not a finding' \
  0 --silent "$(CFG)" missing src/index.ts

run_case 'a linter that errors without findings is not a finding' \
  0 --silent "$(CFG)" broken src/index.ts

run_case 'a linter that hangs is cut off, silently' \
  0 --silent "$(CFG)" hang src/index.ts

run_case 'hooks.lintEdit false switches it off' \
  0 --silent "$(CFG ',"hooks":{"lintEdit":false}}')" findings src/index.ts

run_case 'no config file means /dev-init never ran here' \
  0 --silent --none findings src/index.ts

run_case 'a project with no lint command and no linter says nothing' \
  0 --silent '{"provider":"github"}' --none src/index.ts

# --- it lints exactly the file that was edited, and nothing else ---
dir="$TMP/case-argv"
build_project "$dir" "$(CFG)" echoargs
argv=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$dir/src/index.ts" \
  | env CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" 2>&1 >/dev/null)
if printf '%s' "$argv" | grep -qF 'argv:src/index.ts' && ! printf '%s' "$argv" | grep -qF 'README.md'; then
  printf 'ok    it lints the edited file and no other\n'; pass=$((pass + 1))
else
  printf 'FAIL  it lints the edited file and no other\n      got: %s\n' "$argv"; fail=$((fail + 1))
fi

# --- a malformed payload is not an error ---
dir="$TMP/case-garbage"
build_project "$dir" "$(CFG)" findings
if printf 'not json at all' | env CLAUDE_PROJECT_DIR="$dir" \
  "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" >/dev/null 2>&1; then
  printf 'ok    a payload that is not JSON exits 0\n'; pass=$((pass + 1))
else
  printf 'FAIL  a payload that is not JSON exits 0\n'; fail=$((fail + 1))
fi

# --- the output is bounded, and the same twice ---
dir="$TMP/case-many"
build_project "$dir" "$(CFG)" many
payload=$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$dir/src/index.ts")
first=$(printf '%s' "$payload" | env CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" 2>&1 >/dev/null)
second=$(printf '%s' "$payload" | env CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" 2>&1 >/dev/null)
lines=$(printf '%s\n' "$first" | wc -l | tr -d ' ')
if [ "$lines" -le 25 ] && [ "$first" = "$second" ] && printf '%s' "$first" | grep -qF 'more'; then
  printf 'ok    findings are truncated, and two runs print the same bytes\n'; pass=$((pass + 1))
else
  printf 'FAIL  findings are truncated, and two runs print the same bytes\n      %s lines, identical=%s\n' \
    "$lines" "$([ "$first" = "$second" ] && echo yes || echo no)"; fail=$((fail + 1))
fi

# --- it writes nothing ---
dir="$TMP/case-writes"
build_project "$dir" "$(CFG)" findings
before=$(cd "$dir" && find . -type f -o -type l | sort)
printf '%s' "$payload" >/dev/null
printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$dir/src/index.ts" \
  | env CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" >/dev/null 2>&1
after=$(cd "$dir" && find . -type f -o -type l | sort)
if [ "$before" = "$after" ]; then
  printf 'ok    it writes nothing\n'; pass=$((pass + 1))
else
  printf 'FAIL  it writes nothing\n      %s\n' "$(diff <(printf '%s' "$before") <(printf '%s' "$after"))"
  fail=$((fail + 1))
fi

# --- the ceiling really is a ceiling ---
dir="$TMP/case-ceiling"
build_project "$dir" "$(CFG)" hang
start=$("$NODE_BIN" -p 'Date.now()')
printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$dir/src/index.ts" \
  | env CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/lint-edited-file.mjs" >/dev/null 2>&1
elapsed=$(( $("$NODE_BIN" -p 'Date.now()') - start ))
if [ "$elapsed" -lt 12000 ]; then
  printf 'ok    a hanging linter is bounded (%sms)\n' "$elapsed"; pass=$((pass + 1))
else
  printf 'FAIL  a hanging linter is bounded\n      took %sms\n' "$elapsed"; fail=$((fail + 1))
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
