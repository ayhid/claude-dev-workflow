// Shared boilerplate for .claude/hooks/*.mjs — node: builtins only, no dependencies.
//
// Repo-local development tooling: this lives under .claude/ and is NOT part of
// the shipped payload.
//
// Exit codes are the whole contract: 2 blocks and stderr is the reason Claude
// sees; 0 allows; anything else is a non-blocking error that lets the action
// through. There is no code that blocks *and* reports a hook bug, which is why
// every failure path here allows.
import { readFileSync } from 'node:fs';

/** Parse the hook event payload from stdin. Returns null if it is unusable. */
export function readHookInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Allow the action. */
export function allow() {
  process.exit(0);
}

/** Block the action. `reason` is written to stderr and shown to Claude. */
export function block(reason) {
  process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
  process.exit(2);
}

/**
 * Run a hook body, failing open.
 *
 * A guard that crashes must not become a guard that blocks everything: on a
 * PreToolUse(Bash) matcher that would break every command in the session. So a
 * thrown error degrades to "not enforcing", and says so.
 */
export function run(name, fn) {
  try {
    fn();
  } catch (err) {
    process.stderr.write(`${name}: hook failed (${err?.message ?? err}); not enforcing.\n`);
  }
  process.exit(0);
}
