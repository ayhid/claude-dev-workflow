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
  [ -n "$cfg" ] && printf '%s' "$cfg" > "$dir/.dev-workflow.json"

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
CFG_HOOKS_OFF='{"hooks":{"commitTicket":false}}'
CFG_HOOKS_CONFLICT='{"hooks":{"commitTicket":true},"commit":{"enforce":false}}'
CFG_HOOKS_EMPTY='{"hooks":{}}'
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

# The type in the escape is incidental; the scope is what means "no issue".
# Pinning it to `chore` made every ticketless commit non-releasing under
# conventional-commits, which is why any configured type with that scope passes.
run_case 'escape: any type carries the scope'   0 'git commit -m "feat(no-ticket): add a thing"'
run_case 'escape: a breaking marker is allowed' 0 'git commit -m "fix(no-ticket)!: drop a thing"'
run_case 'escape: a different scope is not one' 2 'git commit -m "feat(other): add a thing"'
run_case 'escape: the scope follows the config' 0 'git commit -m "feat(skip): add a thing"' "$CFG_ESCAPE"
run_case 'escape: a replaced scope stops working' 2 'git commit -m "feat(no-ticket): add a thing"' "$CFG_ESCAPE"
# Reuses commit.types rather than a second list: `docs` is not configured here.
run_case 'escape: the type must be a configured one' 2 'git commit -m "docs(no-ticket): tidy"' "$CFG_TYPES"

# --- commit.position ----------------------------------------------------------
run_case 'prefix: accepts id then type'         0 'git commit -m "ABC-1 feat(api): add endpoint"' "$CFG_PREFIX"
run_case 'prefix: accepts id colon then type'   0 'git commit -m "ABC-1: feat(api): add endpoint"' "$CFG_PREFIX"
run_case 'prefix: rejects a suffix id'          2 'git commit -m "feat(api): add endpoint (ABC-1)"' "$CFG_PREFIX"

# --- config switches ----------------------------------------------------------
run_case 'enforce:false disables the hook'      0 'git commit -m "whatever"'            "$CFG_OFF"
run_case 'hooks.commitTicket:false disables it' 0 'git commit -m "whatever"'            "$CFG_HOOKS_OFF"
# The older spelling can only ever disable. Letting the newer key switch the
# guard back on would mean a config saying "off" in one place and "on" in
# another, and a precedence rule nobody can predict from reading either line.
run_case 'the newer key cannot re-enable it'    0 'git commit -m "whatever"'            "$CFG_HOOKS_CONFLICT"
run_case 'an empty hooks block leaves it on'    2 'git commit -m "whatever"'            "$CFG_HOOKS_EMPTY"
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

# --- a configurable ID pattern -------------------------------------------------
#
# The default must stay byte-identical to the pre-provider behaviour, so every
# case above runs with no config at all. These cover what the key adds.

CFG_GH='{"provider":"github"}'
CFG_GH_PREFIX='{"provider":"github","commit":{"position":"prefix"}}'
CFG_CUSTOM='{"commit":{"idPattern":"TASK_[0-9]+"}}'

run_case 'github: #123 at the suffix is accepted' 0 \
  'git commit -m "fix(api): handle nulls (#123)"' "$CFG_GH"
run_case 'github: no issue reference is blocked' 2 \
  'git commit -m "fix(api): handle nulls"' "$CFG_GH"
run_case 'github: a YouTrack-shaped id no longer counts' 2 \
  'git commit -m "fix(api): handle nulls (ABC-1)"' "$CFG_GH"
run_case 'github: prefix position strips the id before the type' 0 \
  'git commit -m "#123 fix(api): handle nulls"' "$CFG_GH_PREFIX"
run_case 'github: the escape hatch still works' 0 \
  'git commit -m "chore(no-ticket): tidy"' "$CFG_GH"

run_case 'a custom idPattern is honoured' 0 \
  'git commit -m "feat: thing (TASK_42)"' "$CFG_CUSTOM"
run_case 'a custom idPattern rejects the default shape' 2 \
  'git commit -m "feat: thing (ABC-1)"' "$CFG_CUSTOM"

# The one that matters most. A malformed regex makes every [[ =~ ]] return
# non-zero, which would turn this guard into a universal commit blocker — it
# must fall back to the default rather than block everything.
run_case 'fail open: an invalid idPattern falls back, it does not block' 0 \
  'git commit -m "feat: thing (ABC-1)"' '{"commit":{"idPattern":"["}}'
run_case 'fail open: an invalid idPattern still blocks a ticketless commit' 2 \
  'git commit -m "feat: thing"' '{"commit":{"idPattern":"["}}'
run_case 'a comma in idPattern is rejected, not mangled' 0 \
  'git commit -m "feat: thing (ABC-1)"' '{"commit":{"idPattern":"A,B"}}'

without_jq 'no jq: warns that a commit is unchecked' yes 'git commit -m "nope"'
without_jq 'no jq: stays quiet for other commands'   no  'npm test'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
