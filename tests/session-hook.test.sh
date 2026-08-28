#!/usr/bin/env bash
# Table test for hooks/session-standup.mjs.
#
# The hook is Node rather than bash, and that exception is the thing most worth
# testing: it exists to buy a portable timeout, so a case here actually spends
# three seconds proving the timeout fires. Everything else asserts the promise
# in the hook's header — that it can never fail or stall a session — by giving
# it a child that hangs, a child that fails, a project with no config, and a
# config that turns it off, and requiring silence and exit 0 from every one.
#
# `dev.mjs` is stubbed. This is about the hook's own behaviour, not the
# standup's; tests/standup.test.mjs already owns the report.
#
#   usage: tests/session-hook.test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$ROOT/hooks/session-standup.mjs"
NODE_BIN="${NODE:-$(command -v node)}"

[ -f "$HOOK" ] || { echo "tests: no hook at $HOOK" >&2; exit 1; }

pass=0 fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CFG_OK='{"provider":"github","github":{"repo":"a/b","labels":{"Done":"done"}}}'

# build_project <dir> <config-json|--none> <stub-body>
#
# A project laid out the way the installer lays one out: the payload under
# _dev-workflow/, with lib/ symlinked rather than copied so the hook imports the
# real config loader, and scripts/dev.mjs stubbed.
build_project() {
  local dir="$1" cfg="$2" stub="$3"
  mkdir -p "$dir/_dev-workflow/hooks" "$dir/_dev-workflow/scripts"
  ln -sf "$ROOT/lib" "$dir/_dev-workflow/lib"
  cp "$HOOK" "$dir/_dev-workflow/hooks/session-standup.mjs"
  printf '%s\n' "$stub" > "$dir/_dev-workflow/scripts/dev.mjs"
  [ "$cfg" = "--none" ] || printf '%s' "$cfg" > "$dir/.dev-workflow.json"
}

# run_case <desc> <expected-stdout-substring|--silent> <config|--none> <stub> [source]
run_case() {
  local desc="$1" want="$2" cfg="$3" stub="$4" source="${5:-startup}"
  local dir="$TMP/case-$((pass + fail))"
  build_project "$dir" "$cfg" "$stub"

  local out code
  out=$(printf '{"source":"%s"}' "$source" \
    | CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/session-standup.mjs" 2>/dev/null)
  code=$?

  # Exit 0 is not one assertion among several — it is the promise. A hook that
  # exits non-zero can fail a session start, which is the failure this whole
  # file exists to prevent.
  if [ "$code" != 0 ]; then
    fail=$((fail + 1)); printf '  FAIL %s\n       exited %s, must always be 0\n' "$desc" "$code"
    return
  fi

  local ok=no
  if [ "$want" = "--silent" ]; then
    [ -z "$out" ] && ok=yes
  else
    case "$out" in *"$want"*) ok=yes ;; esac
  fi

  if [ "$ok" = yes ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n       want %s, got: %s\n' "$desc" "$want" "$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
  fi
}

STUB_OK='process.stdout.write("standup   2026-01-01\n")'
STUB_FAILS='process.stderr.write("boom\n"); process.exit(1)'
STUB_NOISY='process.stderr.write("an update is available\n"); process.stdout.write("the report\n")'
STUB_EMPTY='process.exit(0)'
# Longer than TIMEOUT_MS, and longer than the margin the timing case allows.
STUB_SLOW='setTimeout(() => process.stdout.write("too late\n"), 10000)'

echo "session-standup.mjs"

# The point of the thing.
run_case 'prints the report a session opens with' 'standup   2026-01-01' "$CFG_OK" "$STUB_OK"
run_case 'prints on resume as well as startup'    'standup   2026-01-01' "$CFG_OK" "$STUB_OK" resume
run_case 'prints on clear'                        'standup   2026-01-01' "$CFG_OK" "$STUB_OK" clear

# Silence, in every case where a greeting would be wrong or unhelpful.
run_case 'a project with no config says nothing'  --silent --none      "$STUB_OK"
run_case 'hooks.sessionStart:false says nothing'  --silent \
  '{"provider":"github","github":{"repo":"a/b","labels":{"Done":"done"}},"hooks":{"sessionStart":false}}' "$STUB_OK"
run_case 'malformed config says nothing'          --silent '{not json' "$STUB_OK"
run_case 'a failing command says nothing'         --silent "$CFG_OK"   "$STUB_FAILS"
run_case 'an empty report says nothing'           --silent "$CFG_OK"   "$STUB_EMPTY"

# Compaction can happen many times inside one session, and re-printing the board
# each time spends context on a report nobody asked for twice.
run_case 'compaction is not a session opening'    --silent "$CFG_OK"   "$STUB_OK" compact

# stderr carries the update banner and any warning. Neither is the report, and
# surfacing them would turn a greeting into noise.
run_case 'child stderr is not surfaced'           'the report' "$CFG_OK" "$STUB_NOISY"

# --- the timeout, for real ----------------------------------------------------
#
# The reason this hook is Node at all: `timeout(1)` is not on a stock macOS, so
# a bash wrapper could not bound its own runtime portably. Asserting the message
# alone would pass just as well if the hook simply waited for the slow child, so
# this measures the clock too.
timeout_case() {
  local dir="$TMP/timeout" out code started elapsed
  build_project "$dir" "$CFG_OK" "$STUB_SLOW"

  started=$SECONDS
  out=$(printf '{"source":"startup"}' \
    | CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/session-standup.mjs" 2>/dev/null)
  code=$?
  elapsed=$((SECONDS - started))

  local problem=''
  [ "$code" = 0 ] || problem="exited $code"
  case "$out" in *"took longer than"*) ;; *) problem="${problem:+$problem; }no timeout line: $out" ;; esac
  # The child sleeps 10s. Anything near that means the timeout did not fire;
  # the ceiling is loose because CI machines are slow, but 6s still separates
  # "gave up at 3" from "waited for the child".
  [ "$elapsed" -le 6 ] || problem="${problem:+$problem; }took ${elapsed}s, the timeout did not fire"

  if [ -z "$problem" ]; then
    pass=$((pass + 1)); printf '  ok   a slow report is abandoned, not waited for (%ss)\n' "$elapsed"
  else
    fail=$((fail + 1)); printf '  FAIL a slow report is abandoned, not waited for\n       %s\n' "$problem"
  fi
}
timeout_case

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
