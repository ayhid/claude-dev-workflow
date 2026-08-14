#!/usr/bin/env bash
# Table test for hooks/check-commit-ticket.sh.
#
# The hook is a pure function — a PreToolUse payload on stdin, an exit code out
# (0 allow, 2 block) — so it is fully testable offline with no YouTrack instance
# and no network. Every case below is a shape that has either bitten us or that
# the config is documented to support.
#
#   usage: tests/hook.test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$ROOT/hooks/check-commit-ticket.sh"
BASH_BIN="${BASH:-$(command -v bash)}"

command -v jq >/dev/null 2>&1 || { echo "tests: jq is required" >&2; exit 1; }
[ -x "$HOOK" ] || [ -f "$HOOK" ] || { echo "tests: no hook at $HOOK" >&2; exit 1; }

pass=0 fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# run_case <description> <expected-exit> <command> [config-json]
#
# The config is written to a scratch dir handed to the hook as
# $CLAUDE_PROJECT_DIR, which is where its config walk starts.
run_case() {
  local desc="$1" want="$2" cmd="$3" cfg="${4-}"
  local dir="$TMP/case-$((pass + fail))"
  mkdir -p "$dir"
  [ -n "$cfg" ] && printf '%s' "$cfg" > "$dir/.youtrack.json"

  local payload got err
  payload=$(jq -n --arg c "$cmd" '{tool_name:"Bash", tool_input:{command:$c}}')
  err=$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$dir" bash "$HOOK" 2>&1 >/dev/null)
  got=$?

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n       want exit %s, got %s\n' "$desc" "$want" "$got"
    [ -n "$err" ] && printf '       stderr: %s\n' "$(printf '%s' "$err" | head -3 | tr '\n' ' ')"
  fi
}

CFG_PREFIX='{"commit":{"position":"prefix"}}'
CFG_OFF='{"commit":{"enforce":false}}'
CFG_NOTYPE='{"commit":{"requireType":false}}'
CFG_TYPES='{"commit":{"types":["feat","fix"]}}'
CFG_ESCAPE='{"commit":{"noTicketEscape":"chore(skip)"}}'

echo "check-commit-ticket.sh"

# --- things the hook must not touch -------------------------------------------
run_case 'ignores a non-git command'            0 'npm test'
run_case 'ignores git commands that are not commit' 0 'git status --short'
run_case 'ignores commit with no inline message' 0 'git commit'
run_case 'ignores --amend --no-edit'            0 'git commit --amend --no-edit'
run_case 'ignores -F file messages'             0 'git commit -F /tmp/msg.txt'

# --- the default: conventional commit, ID at the suffix -----------------------
run_case 'accepts a valid suffix subject'       0 'git commit -m "feat(api): add endpoint (ABC-1)"'
run_case 'accepts multi-digit ids'              0 'git commit -m "fix(ui): tidy (ABC-1234)"'
run_case 'accepts a breaking-change marker'     0 'git commit -m "feat(api)!: drop v1 (ABC-1)"'
run_case 'accepts a scopeless type'             0 'git commit -m "docs: update readme (ABC-1)"'
run_case 'accepts git -C <path> commit'         0 'git -C ../frontend commit -m "fix(x): y (ABC-9)"'
run_case 'rejects a missing issue id'           2 'git commit -m "feat(api): add endpoint"'
run_case 'rejects a missing conventional type'  2 'git commit -m "add endpoint (ABC-1)"'
run_case 'rejects an unknown type'              2 'git commit -m "wibble(api): thing (ABC-1)"'
run_case 'rejects a bare prefix id by default'  2 'git commit -m "ABC-1: add endpoint"'

# --- multiline messages: only the subject is validated ------------------------
run_case 'accepts a valid subject with a body'  0 'git commit -m "feat(api): add endpoint (ABC-1)

Longer explanation that mentions no ticket at all."'
run_case 'rejects a bad subject despite a good body' 2 'git commit -m "add endpoint

feat(api): thing (ABC-1)"'

# --- the escape hatch ---------------------------------------------------------
run_case 'accepts the default escape hatch'     0 'git commit -m "chore(no-ticket): bump deps"'
run_case 'accepts a configured escape hatch'    0 'git commit -m "chore(skip): bump deps"' "$CFG_ESCAPE"
run_case 'default escape is replaced, not added' 2 'git commit -m "chore(no-ticket): bump deps"' "$CFG_ESCAPE"

# --- commit.position ----------------------------------------------------------
run_case 'prefix: accepts id then type'         0 'git commit -m "ABC-1 feat(api): add endpoint"' "$CFG_PREFIX"
run_case 'prefix: accepts id colon then type'   0 'git commit -m "ABC-1: feat(api): add endpoint"' "$CFG_PREFIX"
run_case 'prefix: rejects a suffix id'          2 'git commit -m "feat(api): add endpoint (ABC-1)"' "$CFG_PREFIX"

# --- config switches ----------------------------------------------------------
run_case 'enforce:false disables the hook'      0 'git commit -m "whatever"'            "$CFG_OFF"
run_case 'requireType:false keeps the id check' 0 'git commit -m "add endpoint (ABC-1)"' "$CFG_NOTYPE"
run_case 'requireType:false still needs an id'  2 'git commit -m "add endpoint"'         "$CFG_NOTYPE"
run_case 'honours a narrowed type list'         0 'git commit -m "fix(api): thing (ABC-1)"' "$CFG_TYPES"
run_case 'rejects a type outside the list'      2 'git commit -m "perf(api): thing (ABC-1)"' "$CFG_TYPES"

# --- malformed config must not crash the hook ---------------------------------
run_case 'tolerates invalid json config'        0 'git commit -m "feat(api): thing (ABC-1)"' '{not json'

# --- without jq the hook cannot enforce, and must say so ----------------------
# It allows (blocking every Bash call would be far worse) but must not vanish
# silently, and must stay quiet for commands that are not commits.
without_jq() {
  local desc="$1" want_warn="$2" cmd="$3"
  local dir="$TMP/nojq-$((pass + fail))" stub="$TMP/nojq-bin"
  mkdir -p "$dir" "$stub"
  # A PATH with the ordinary tools but no jq. Emptying PATH instead would take
  # `cat` with it and the hook would die at 127 before reaching the check.
  local real
  for tool in cat grep sed head tr dirname mktemp; do
    real=$(command -v "$tool") && ln -sf "$real" "$stub/$tool"
  done
  local payload err code
  payload=$(jq -n --arg c "$cmd" '{tool_name:"Bash", tool_input:{command:$c}}')
  # bash by absolute path: the stubbed PATH would not find bash itself.
  err=$(printf '%s' "$payload" \
    | PATH="$stub" CLAUDE_PROJECT_DIR="$dir" "$BASH_BIN" "$HOOK" 2>&1 >/dev/null)
  code=$?

  local got=no
  case "$err" in *"NOT being enforced"*) got=yes ;; esac

  if [ "$code" = 0 ] && [ "$got" = "$want_warn" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n       want exit 0 and warn=%s, got exit %s warn=%s\n' \
      "$desc" "$want_warn" "$code" "$got"
  fi
}

without_jq 'no jq: warns that a commit is unchecked' yes 'git commit -m "nope"'
without_jq 'no jq: stays quiet for other commands'   no  'npm test'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
