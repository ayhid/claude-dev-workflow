---
name: workflow-audit
description: Audit a project's Claude Code workflow — find conventions nothing enforces, checks that never run, and procedure that should be a skill — and deliver ready-to-write hook files. Use when asked to audit, review or harden the agent setup in a repo.
argument-hint: "[optional: a surface to focus on, e.g. hooks, skills, CLAUDE.md]"
---

# Workflow audit

Repo-local: this skill is development tooling for this repository and is **not** shipped to users.
`bin/lib/payload.mjs` copies `lib/`, `scripts/`, `hooks/` and `skills/`; nothing under `.claude/`
reaches a user's project.

The question this skill answers is narrow: **where does this project state a rule that nothing
actually enforces?** Prose in `CLAUDE.md` is a request. A hook is a guarantee. Most of what an
audit finds is the gap between the two.

`$ARGUMENTS` may name a single surface to focus on. If empty, audit all of them.

## 1. Inventory

Read before judging. Each of these carries a different signal:

| Read | Signal |
|---|---|
| `CLAUDE.md`, `.claude/rules/*` | The rules the project *claims*. Every imperative here is a candidate for enforcement. |
| `.claude/settings.json`, `.claude/settings.local.json` | What is actually enforced, and at which event. |
| `.claude/hooks/` | Existing guards — their language, their failure mode, their cost. |
| `.claude/skills/`, `.claude/commands/` | Procedure already captured. Anything repeated in transcripts but absent here is a gap. |
| `package.json` scripts, `Makefile`, `.github/workflows/` | The checks that exist. Compare against what runs locally before a commit. |
| `.husky/`, `.git/hooks/` | Enforcement that already exists outside Claude — do not duplicate it. |
| `git log` on the last ~50 commits | Whether the stated conventions are actually being followed. A convention obeyed 100% of the time may not need a hook; one obeyed 60% of the time does. |

Note what you could **not** read. An audit that silently skipped `.claude/settings.local.json`
because it was absent should say so.

## 2. Gap analysis

Group findings by surface. Every finding states three things — the gap, the **evidence** (a file
and line, or a commit), and the cost of leaving it. A finding without evidence is a guess; drop it.

### Conventions without enforcement

Walk every imperative in `CLAUDE.md` and ask what happens if it is violated. Three outcomes:
enforced by a hook, caught later by CI, or nothing at all. Only the third is a finding.

Be honest about which are worth enforcing. A convention that is cheap to violate and cheap to fix
later does not need a guard; one that ships to users on `main` does.

### Hooks

Assess existing hooks on: which event they bind to, whether the matcher is tight enough, what they
do when they cannot parse their own input, and what they cost on the hot path.

**Every hook this skill proposes must obey the conventions in §3.** No exceptions, and no
"you could also use X" asides that violate them.

### Skills and commands

Look for procedure that is repeated, ordered, and easy to get wrong — that is what a skill is for.
Look also for the opposite: a skill that encodes something always true, which belongs in
`CLAUDE.md` instead, since a skill has to be invoked to help.

### Checks and CI

Find checks that exist but are not reachable at the moment they would help. A lint rule that only
runs in CI cannot stop a bad commit locally.

### Context hygiene

`CLAUDE.md` is loaded into every session, so its cost is paid on every turn. Flag content that is
derivable from the code, restates git history, or documents a past fix rather than a standing
convention.

## 3. Hook conventions — mandatory

These are constraints on **your output**, not suggestions to relay to the user. A draft that
violates any of them is wrong and must be rewritten before you present it.

1. **Native Node, single file.** Every proposed hook is a standalone `.mjs` script under
   `.claude/hooks/`, runnable with plain `node`, importing only `node:` builtins.

2. **Zero dependencies.** No `zx`, no `execa`, no `tsx`, no Bun. **Never suggest adding an npm
   dependency for a hook**, not even a dev dependency. A hook runs in whatever project it is
   installed in — that project may have no `node_modules`, no `package.json`, and may not be a
   JavaScript project at all. This is the same rule that is already load-bearing for `lib/` and
   `scripts/` in this repo; see `CLAUDE.md`.

3. **Read the payload with `readFileSync(0, "utf8")` and `JSON.parse`.** Not an async stream
   reader, not a `for await` loop over `process.stdin` — a hook is a short synchronous script and
   the payload is small.

4. **Spawn with `execFileSync` from `node:child_process`.** Argument arrays only. Never an
   interpolated shell string, never `exec`, never `execSync`. This is the same reasoning as
   `lib/sh.mjs`: an argument array is what guarantees a value containing a space, a quote or a `$`
   reaches the program intact, and it is what keeps anything sensitive out of a process listing.

5. **Exit 2 to block, with the reason on stderr. Exit 0 to allow. Never exit 1 for enforcement.**
   This is not stylistic. Exit 2 is the only code that blocks: stderr becomes the blocking reason
   and is surfaced to Claude. Exit 0 allows, and stderr on that path goes to the debug log only.
   **Any other non-zero code is a non-blocking error — the action proceeds anyway.** A guard
   written with `exit 1` therefore enforces nothing while looking like it works, which is worse
   than having no guard at all.

6. **Fail open, loudly.** A hook that cannot parse its payload, or that throws, must allow and
   write a warning to stderr. It must never block. A `PreToolUse` guard on `Bash` that starts
   blocking on every call because of its own bug takes the whole session down; a guard that stops
   enforcing while saying so is recoverable.

7. **Defer rather than guess.** If the thing being validated cannot be extracted confidently —
   an unparseable command, a branch that cannot be determined — allow. False positives from a
   guard are expensive; they train people to disable it.

8. **Import-light, fast bail first.** A `PreToolUse` matcher on `Bash` fires on *every* command,
   so cold start dominates. Put the cheapest discriminating test first (a `String.includes` before
   a regex, a regex before spawning `git`), and only reach for a subprocess once the hook is
   confident it is on the path it cares about.

9. **Shared boilerplate lives in `.claude/hooks/lib.mjs`**, imported relatively:
   `import { readHookInput, allow, block, run } from "./lib.mjs";`. Stdin parsing, the
   allow/block helpers and the fail-open wrapper go there; nothing hook-specific does.

10. **Wire it with** `node $CLAUDE_PROJECT_DIR/.claude/hooks/<name>.mjs` in `settings.json`.
    `$CLAUDE_PROJECT_DIR` is exported to hook commands and is safe in the command string; a
    relative path is not, because the hook's working directory is not guaranteed.

Merge into `.claude/settings.json`, never rewrite it — users have their own hooks there.

## 4. Reference example

Every hook draft in your output must look like this. This is the shape, the comment density and
the error text to match.

### `.claude/hooks/lib.mjs`

```js
// Shared boilerplate for .claude/hooks/*.mjs — node: builtins only, no dependencies.
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
```

### `.claude/hooks/no-force-push.mjs`

```js
#!/usr/bin/env node
// PreToolUse(Bash) guard: no force-push to a protected branch.
//
// Exit 0 = allow. Exit 2 = block (stderr is surfaced to Claude).
// No network, no dependencies, no shell.
import { execFileSync } from 'node:child_process';
import { readHookInput, allow, block, run } from './lib.mjs';

const PROTECTED = new Set(['main', 'master']);

run('no-force-push', () => {
  const input = readHookInput();

  // Without a payload this hook cannot enforce anything. Blocking every Bash
  // call would be the worse failure, so allow — but say it out loud, because
  // silent loss of enforcement is the thing worth being noisy about.
  if (!input) {
    process.stderr.write('no-force-push: unreadable hook payload; not enforcing.\n');
    allow();
  }

  const cmd = input.tool_input?.command ?? '';
  if (!cmd) allow();

  // Fast bail, cheapest test first: this runs on every Bash call.
  if (!cmd.includes('push')) allow();
  if (!/(^|[;&|\s])git(\s+-C\s+\S+)*\s+push(\s|$)/.test(cmd)) allow();
  if (!/(^|\s)(-f|--force)(\s|$)/.test(cmd)) allow();

  // An explicit refspec names a branch other than the checked-out one.
  const refspec = cmd.match(/\s(?:HEAD:)?refs\/heads\/([^\s:]+)/);
  const branch = refspec ? refspec[1] : currentBranch(input.cwd);

  // Could not tell which branch: defer rather than guess.
  if (!branch) allow();
  if (!PROTECTED.has(branch)) allow();

  block(
    [
      'BLOCKED: force-push to a protected branch.',
      `  got:       ${cmd}`,
      `  branch:    ${branch}`,
      `  protected: ${[...PROTECTED].join(', ')}`,
      '  Force-pushing rewrites history other clones already have.',
      '  If this is genuinely intended, run it yourself outside the agent.',
    ].join('\n'),
  );
});

/** The checked-out branch, or null. Argument array — never an interpolated shell string. */
function currentBranch(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}
```

### `.claude/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node $CLAUDE_PROJECT_DIR/.claude/hooks/no-force-push.mjs"
          }
        ]
      }
    ]
  }
}
```

### Manual test

```bash
# allows — not a push
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"'"$PWD"'"}' \
  | node .claude/hooks/no-force-push.mjs; echo "exit=$?"      # exit=0, no stderr

# blocks — force-push to a protected refspec
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin HEAD:refs/heads/main"},"cwd":"'"$PWD"'"}' \
  | node .claude/hooks/no-force-push.mjs; echo "exit=$?"      # exit=2, reason on stderr

# fails open — malformed payload
echo 'not json' | node .claude/hooks/no-force-push.mjs; echo "exit=$?"   # exit=0, warning on stderr
```

## 5. Deliverables

Present findings in three buckets. Be willing to leave the third one long — the point of an audit
is judgement, not a backlog.

### Quick wins

**Complete `.mjs` files, following §3, ready to write to disk.** Not a sketch, not pseudocode, not
"you could add a hook that…". If you cannot write the whole file, it is not a quick win — move it
to the next bucket and say what is unresolved.

Each quick win carries, in this order:

1. One sentence: the gap it closes, and the evidence from §2.
2. The full file body.
3. The `.claude/settings.json` entry to merge in.
4. The manual test — an `echo '<payload>' | node .claude/hooks/<name>.mjs; echo "exit=$?"` line
   for the allow path, the block path, and the malformed-payload path.

Before presenting, check each draft against §3 yourself: single file, `node:` imports only, no npm
dependency, `readFileSync(0, "utf8")`, `execFileSync` with an argument array, exit 0 or 2 and never
1, fast bail first, fail open.

### Larger changes

Things worth doing that do not fit in one file — a new skill, restructuring `CLAUDE.md`, a CI
change. Describe the shape and the cost. Do not draft them unless asked.

### Not worth it

Gaps you found and are deliberately not proposing to close, with the reason. This bucket is what
makes the other two credible.

Then stop. Write nothing to disk unless the user asks for it.
