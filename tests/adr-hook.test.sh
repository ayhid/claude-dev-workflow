#!/usr/bin/env bash
# Table test for hooks/check-adr-immutable.sh.
#
# The hook is a pure function — a PreToolUse payload on stdin, an exit code out
# (0 allow, 2 block) — so it needs no tracker, no network and no Claude Code.
# Every case is a shape the guard is documented to allow or refuse; the ones
# that allow matter most, because a guard that blocks too much gets removed.
#
#   usage: tests/adr-hook.test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$ROOT/hooks/check-adr-immutable.sh"
BASH_BIN="${BASH:-$(command -v bash)}"

command -v jq >/dev/null 2>&1 || { echo "tests: jq is required" >&2; exit 1; }
[ -f "$HOOK" ] || { echo "tests: no hook at $HOOK" >&2; exit 1; }

pass=0 fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

adr_body() { printf '# 0001. A decision\n\n- Status: %s\n- Date: 2026-08-28\n\n## Context\n\nx\n' "$1"; }

# run_case <desc> <expected-exit> <status|--absent> [opts]
#   --name F     write/target this filename instead of 0001-a-decision.md
#   --sub  D     put the file in this subdirectory of the project
#   --cfg  JSON  write this .dev-workflow.json
#   --tool T     tool_name in the payload (default Edit)
run_case() {
  local desc="$1" want="$2" status="$3"; shift 3
  local name='0001-a-decision.md' sub='docs/decisions' cfg='' tool='Edit'
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --sub)  sub="$2";  shift 2 ;;
      --cfg)  cfg="$2";  shift 2 ;;
      --tool) tool="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local dir="$TMP/case-$((pass + fail))"
  mkdir -p "$dir/$sub"
  [ -n "$cfg" ] && printf '%s' "$cfg" > "$dir/.dev-workflow.json"
  local target="$dir/$sub/$name"
  [ "$status" = "--absent" ] || adr_body "$status" > "$target"

  local payload got err
  payload=$(jq -n --arg p "$target" --arg t "$tool" \
    '{tool_name:$t, tool_input:{file_path:$p, old_string:"a", new_string:"b"}}')
  err=$(printf '%s' "$payload" | CLAUDE_PROJECT_DIR="$dir" "$BASH_BIN" "$HOOK" 2>&1 >/dev/null)
  got=$?

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n       want exit %s, got %s\n' "$desc" "$want" "$got"
    [ -n "$err" ] && printf '       stderr: %s\n' "$(printf '%s' "$err" | head -3 | tr '\n' ' ')"
  fi
}

# without_jq <desc> <yes|no expected warning> <status>
without_jq() {
  local desc="$1" want="$2" status="$3"
  local dir="$TMP/nojq-$((pass + fail))" stub="$TMP/stub-$((pass + fail))"
  mkdir -p "$dir/docs/decisions" "$stub"
  adr_body "$status" > "$dir/docs/decisions/0001-a-decision.md"
  # A PATH with the ordinary tools but no jq. Emptying PATH instead would take
  # `cat` with it and the hook would die at 127 before reaching the check.
  local real
  for tool in cat grep sed head tr dirname mktemp; do
    real=$(command -v "$tool") && ln -sf "$real" "$stub/$tool"
  done
  local payload err
  payload=$(jq -n --arg p "$dir/docs/decisions/0001-a-decision.md" \
    '{tool_name:"Edit", tool_input:{file_path:$p}}')
  err=$(printf '%s' "$payload" \
    | PATH="$stub" CLAUDE_PROJECT_DIR="$dir" "$BASH_BIN" "$HOOK" 2>&1 >/dev/null)

  local got=no
  case "$err" in *"NOT protected"*) got=yes ;; esac
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n       want warning=%s, got %s\n' "$desc" "$want" "$got"
  fi
}

echo "check-adr-immutable.sh"

# The one thing it must block.
run_case 'an accepted record is blocked'                    2 accepted
run_case 'blocked through Write as well as Edit'            2 accepted --tool Write

# Everything it must not block. These matter more: a guard that overreaches
# gets switched off, and then nothing is enforced at all.
run_case 'a proposed record is still being written'         0 proposed
run_case 'a rejected record is left alone'                  0 rejected
run_case 'a superseded record is left to the command'       0 superseded
run_case 'a file that does not exist yet is a creation'     0 --absent
run_case 'the generated index is not a record'              0 accepted --name README.md
run_case 'a non-ADR filename is ignored'                    0 accepted --name notes.md
run_case 'an ADR-shaped file elsewhere is not ours'         0 accepted --sub docs/other
run_case 'a source file is never touched'                   0 accepted --name 0001-thing.md --sub src

# Config.
run_case 'a custom decisionsDir is honoured'                2 accepted \
  --sub adr --cfg '{"docs":{"decisionsDir":"adr"}}'
run_case 'the default dir no longer applies once moved'     0 accepted \
  --cfg '{"docs":{"decisionsDir":"adr"}}'
run_case 'docs.enforce:false disables the guard'            0 accepted \
  --cfg '{"docs":{"enforce":false}}'
run_case 'invalid json falls back to the default dir'       2 accepted --cfg '{not json'

# Degradation.
without_jq 'no jq: warns that records are unprotected'      yes accepted
without_jq 'no jq: warns regardless of status, it cannot read one' yes proposed

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
