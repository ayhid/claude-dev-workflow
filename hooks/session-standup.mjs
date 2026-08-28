#!/usr/bin/env node
/**
 * SessionStart hook: print `dev.mjs standup` when a session opens.
 *
 * Opening a session gives no picture of where the work stands, so the state
 * gets re-derived by hand or, more often, not asked for at all — and something
 * new gets started while something older sits half-finished. This prints the
 * report the tool can already produce.
 *
 * It is wiring, not a feature: `standup` is the whole report and is already
 * safe to run unattended ("it reports and never writes" is a contract there,
 * precisely because it is the first thing run in the morning). No second
 * renderer, no second scanner — scripts/cmd/standup.mjs refuses to reimplement
 * `status`'s scan for the same reason, and a bespoke session digest would be a
 * third copy.
 *
 * ## Why this one is Node, when hooks/ is otherwise bash and jq
 *
 * The bash rule exists because `PreToolUse` with `matcher: "Bash"` fires on
 * every command, so check-commit-ticket.sh's non-commit bail must cost ~3ms
 * rather than a ~50ms node boot. `SessionStart` fires **once per session**, so
 * that budget does not apply and a node boot is affordable.
 *
 * It is also the only way to keep the timeout promise below. `timeout(1)` is
 * not present on a stock macOS — it is `gtimeout`, from coreutils — so a bash
 * wrapper cannot bound its own runtime portably. `spawnSync`'s `timeout` can.
 * That, not preference, is why the exception is here.
 *
 * ## It may never fail or stall a session
 *
 * Same rule as lib/metrics.mjs: an instrument that breaks what it measures is
 * worse than none. Every path below exits 0, the report is bounded at
 * TIMEOUT_MS, and stderr from the child is dropped rather than surfaced — an
 * update banner is not part of the report. The worst case is one line saying
 * the report timed out, which is a fact worth printing; silence would read
 * identically to a project with nothing in flight.
 *
 * Zero dependencies, like everything else under _dev-workflow/: this runs from
 * an installed copy in someone else's Python or Rust repo.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';

/**
 * How long the report gets before it is abandoned.
 *
 * `standup` does per-repo git reads plus a `gh pr list`, and a session opening
 * is the one moment a person is waiting on nothing else. Three seconds is the
 * budget: past it, say so in a line rather than holding the session open. A
 * project that routinely exceeds it wants `/dev-standup` on demand, which is
 * what the timeout line points at.
 */
const TIMEOUT_MS = 3000;

/**
 * The session events worth greeting.
 *
 * `compact` is deliberately absent. Compaction can happen repeatedly inside one
 * session, and re-printing the board each time spends context on a report
 * nobody asked for twice — the opposite of what this is for. `startup`,
 * `resume` and `clear` are the three that begin a session's context.
 */
const GREETED = new Set(['startup', 'resume', 'clear']);

/**
 * The hook payload's `source`, or `startup` when there is nothing to read.
 *
 * Reading fd 0 throws when nothing is piped, which is the normal case for a
 * hand-run invocation. That is not a reason to print nothing: defaulting to a
 * greeted source keeps the hook testable from a shell.
 */
function sourceFromStdin() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) return 'startup';
    const parsed = JSON.parse(raw);
    return typeof parsed?.source === 'string' ? parsed.source : 'startup';
  } catch {
    return 'startup';
  }
}

function main() {
  if (!GREETED.has(sourceFromStdin())) return;

  // The payload knows where it lives; CLAUDE_PROJECT_DIR is the project it was
  // installed into. Both are needed: the first finds dev.mjs, the second is
  // where the config walk has to start.
  const here = dirname(fileURLToPath(import.meta.url));
  const dev = join(here, '..', 'scripts', 'dev.mjs');
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

  // A malformed config is the user's problem to see from a real command, not
  // from a greeting. Treat it as "nothing to say".
  let loaded;
  try {
    loaded = loadConfig({ dir: projectDir });
  } catch {
    return;
  }

  // No config file means /dev-init has not been run. That is not an error worth
  // greeting someone with, and .claude/settings.json is shared with whatever
  // else the user has installed — so this stays silent rather than advertising.
  // `loadConfig` returns the defaults in that case, which would otherwise look
  // like a perfectly valid project.
  if (!loaded.file) return;
  if (loaded.config?.hooks?.sessionStart === false) return;

  // `root` rather than projectDir: a .claude/dev-workflow.json sits one level
  // below the root it configures, and a session opened inside a worktree walks
  // up to the config that worktree carries.
  const result = spawnSync(process.execPath, [dev, 'standup'], {
    cwd: loaded.root,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    // stderr carries the update banner and any warning, neither of which is
    // part of the report. Dropping it is what keeps this from becoming noise.
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.error?.code === 'ETIMEDOUT' || result.signal) {
    process.stdout.write(
      `standup: no report — it took longer than ${TIMEOUT_MS / 1000}s. Run /dev-standup for the full picture.\n`,
    );
    return;
  }

  // A non-zero exit is a command that already explained itself on the stderr we
  // just dropped. Printing half a report would be worse than printing none.
  if (result.status !== 0) return;

  const out = String(result.stdout ?? '');
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
}

// One catch around everything, and no exit code but zero. A hook that can fail
// a session start is a hook that gets uninstalled.
try {
  main();
} catch {
  /* a greeting is never worth a broken session */
}
process.exit(0);
