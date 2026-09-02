#!/usr/bin/env bash
# Table test for hooks/session-updatecheck.mjs.
#
# The hook reports a newer published version when a session opens, and never
# updates anything. Every case here asserts the promise in its header — it can
# never fail or stall a session — by requiring exit 0 from all of them, and
# silence from every one where a notice would be wrong: no config, turned off,
# up to date, no manifest, a registry that does not answer.
#
# The network is never reached: the latest version is seeded into the cache
# file lib/updatecheck.mjs already keeps, and the registry, where a case needs
# one, is a local socket that hangs or refuses.
#
#   usage: tests/update-hook.test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$ROOT/hooks/session-updatecheck.mjs"
NODE_BIN="${NODE:-$(command -v node)}"

[ -f "$HOOK" ] || { echo "tests: no hook at $HOOK" >&2; exit 1; }

pass=0 fail=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

CFG_OK='{"provider":"github","github":{"repo":"a/b","labels":{"Done":"done"}}}'
CFG_OFF='{"provider":"github","github":{"repo":"a/b","labels":{"Done":"done"}},"hooks":{"updateCheck":false}}'
NOW_MS=$("$NODE_BIN" -p 'Date.now()')

# build_project <dir> <config-json|--none> <installed-version|--none> <cache-json|--none>
build_project() {
  local dir="$1" cfg="$2" installed="$3" cache="$4"
  mkdir -p "$dir/_dev-workflow/hooks" "$dir/_dev-workflow/_config"
  ln -sf "$ROOT/lib" "$dir/_dev-workflow/lib"
  cp "$HOOK" "$dir/_dev-workflow/hooks/session-updatecheck.mjs"
  [ "$cfg" = "--none" ] || printf '%s' "$cfg" > "$dir/.dev-workflow.json"
  [ "$installed" = "--none" ] || printf '{"installation":{"version":"%s"},"payloadDir":"_dev-workflow","files":[]}' "$installed" \
    > "$dir/_dev-workflow/_config/manifest.json"
  [ "$cache" = "--none" ] || printf '%s' "$cache" > "$dir/_dev-workflow/_config/updatecheck.json"
}

# run_case <desc> <expected-stdout-substring|--silent> <config> <installed> <cache> [source] [extra env...]
run_case() {
  local desc="$1" want="$2" cfg="$3" installed="$4" cache="$5" source="${6:-startup}"
  shift 6 2>/dev/null || shift $#
  local dir="$TMP/case-$((pass + fail))"
  build_project "$dir" "$cfg" "$installed" "$cache"

  local out code
  out=$(printf '{"source":"%s"}' "$source" \
    | env CLAUDE_PROJECT_DIR="$dir" "$@" "$NODE_BIN" "$dir/_dev-workflow/hooks/session-updatecheck.mjs" 2>/dev/null)
  code=$?

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

BEHIND_CACHE=$(printf '{"latest":"9.9.9","checkedAt":%s,"announced":"9.9.9"}' "$NOW_MS")
CURRENT_CACHE=$(printf '{"latest":"1.0.0","checkedAt":%s,"announced":"1.0.0"}' "$NOW_MS")
BANNER='An update is available: 1.0.0 → 9.9.9 — npx claude-dev-workflow@latest --update'

echo "session-updatecheck.mjs"

# The point of the thing: every session, from the cache, even after a command already said it.
run_case 'says a newer version exists when a session opens'   "$BANNER" "$CFG_OK" 1.0.0 "$BEHIND_CACHE"
run_case 'says it on resume'                                   "$BANNER" "$CFG_OK" 1.0.0 "$BEHIND_CACHE" resume
run_case 'says it on clear'                                    "$BANNER" "$CFG_OK" 1.0.0 "$BEHIND_CACHE" clear
run_case 'says it even with no network at all'                 "$BANNER" "$CFG_OK" 1.0.0 "$BEHIND_CACHE" startup DEV_WORKFLOW_NO_NETWORK=1

# Silence, wherever a notice would be wrong.
run_case 'compaction is not a session opening'                 --silent "$CFG_OK"  1.0.0 "$BEHIND_CACHE" compact
run_case 'up to date says nothing'                             --silent "$CFG_OK"  1.0.0 "$CURRENT_CACHE"
run_case 'a project with no config says nothing'               --silent --none     1.0.0 "$BEHIND_CACHE"
run_case 'hooks.updateCheck:false says nothing'                --silent "$CFG_OFF" 1.0.0 "$BEHIND_CACHE"
run_case 'malformed config says nothing'                       --silent '{not json' 1.0.0 "$BEHIND_CACHE"
run_case 'no manifest says nothing'                            --silent "$CFG_OK"  --none "$BEHIND_CACHE"
run_case 'DEV_WORKFLOW_NO_BANNER says nothing'                 --silent "$CFG_OK"  1.0.0 "$BEHIND_CACHE" startup DEV_WORKFLOW_NO_BANNER=1
run_case 'a registry that refuses the connection says nothing' --silent "$CFG_OK"  1.0.0 --none startup DEV_WORKFLOW_REGISTRY_URL=http://127.0.0.1:1/dist-tags

# It reports; it never updates. The manifest is exactly what it was.
dir="$TMP/never-writes"; build_project "$dir" "$CFG_OK" 1.0.0 "$BEHIND_CACHE"
before=$(cat "$dir/_dev-workflow/_config/manifest.json")
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$dir" "$NODE_BIN" "$dir/_dev-workflow/hooks/session-updatecheck.mjs" >/dev/null 2>&1
if [ "$(cat "$dir/_dev-workflow/_config/manifest.json")" = "$before" ] && [ "$(ls "$dir/_dev-workflow" | sort | tr '\n' ' ')" = "_config hooks lib " ]; then
  pass=$((pass + 1)); printf '  ok   it reports and never updates: the install is untouched\n'
else
  fail=$((fail + 1)); printf '  FAIL it reports and never updates: something under _dev-workflow/ changed\n'
fi

# --- the timeout, for real ----------------------------------------------------
#
# A registry that accepts and never answers. The hook must give up within its
# budget and still exit 0; anything near the server's own patience means it
# waited.
SERVER_OUT="$TMP/server.port"
"$NODE_BIN" -e '
  const s = require("node:http").createServer(() => {});
  s.listen(0, "127.0.0.1", () => { require("node:fs").writeFileSync(process.argv[1], String(s.address().port)); });
  setTimeout(() => process.exit(0), 20000);
' "$SERVER_OUT" &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$SERVER_OUT" ] && break; sleep 0.2; done
PORT=$(cat "$SERVER_OUT" 2>/dev/null || echo 1)

dir="$TMP/timeout"; build_project "$dir" "$CFG_OK" 1.0.0 --none
started=$SECONDS
out=$(printf '{"source":"startup"}' \
  | CLAUDE_PROJECT_DIR="$dir" DEV_WORKFLOW_REGISTRY_URL="http://127.0.0.1:$PORT/dist-tags" \
    "$NODE_BIN" "$dir/_dev-workflow/hooks/session-updatecheck.mjs" 2>/dev/null)
code=$?
elapsed=$((SECONDS - started))
problem=''
[ "$code" = 0 ] || problem="exited $code"
[ -z "$out" ] || problem="${problem:+$problem; }printed something for a registry that never answered: $out"
[ "$elapsed" -le 6 ] || problem="${problem:+$problem; }took ${elapsed}s, the timeout did not fire"
if [ -z "$problem" ]; then
  pass=$((pass + 1)); printf '  ok   a registry that hangs is abandoned, silently (%ss)\n' "$elapsed"
else
  fail=$((fail + 1)); printf '  FAIL a registry that hangs is abandoned, silently\n       %s\n' "$problem"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
