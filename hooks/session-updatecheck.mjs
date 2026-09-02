#!/usr/bin/env node
/**
 * SessionStart hook: say, in one line, that a newer version is published.
 * It checks; it never updates.
 *
 * A project's installed copy falls behind silently. `dev.mjs version` answers
 * when asked and every ticket command prints a banner once a day on stderr —
 * but session-standup.mjs drops its child's stderr on purpose, so the one
 * moment somebody is reliably reading, the opening of a session, said nothing.
 * This prints that same line, and nothing else: no install, no network past
 * the cached daily lookup lib/updatecheck.mjs already keeps, no output at all
 * when the project is current.
 *
 * It is a second SessionStart hook rather than a paragraph in the first, so
 * that `hooks.sessionStart: false` — no standup — does not also switch off the
 * version notice. `hooks.updateCheck: false` is this one's own switch, read by
 * the hook itself, which is what makes the opt-out survive `--update`.
 *
 * ## Why this is Node, when hooks/ is otherwise bash and jq
 *
 * Argued here rather than cited, as CLAUDE.md asks of every Node hook. The
 * bash rule exists because `PreToolUse` with `matcher: "Bash"` runs on every
 * command and its non-commit bail has to cost ~3ms. `SessionStart` runs once
 * per session, so that budget does not apply and a node boot is affordable.
 *
 * And the hook has to bound its own runtime. `timeout(1)` is not on a stock
 * macOS — that is `gtimeout`, from coreutils — so a bash wrapper around a
 * network call could not keep a portable promise. `AbortSignal.timeout` on
 * the fetch and a hard exit below can. Zero dependencies still binds in full:
 * this runs from the installed copy in someone else's Python or Rust repo.
 *
 * ## It may never fail or stall a session
 *
 * Every path exits 0. The lookup is bounded by lib/updatecheck.mjs's own
 * network timeout, and BUDGET_MS is the ceiling on the whole hook regardless:
 * past it the process exits, silently, because a greeting that delays a
 * session is worse than no greeting. Nothing is printed on any failure —
 * silence reads the same as "up to date", which is the honest reading of
 * "could not find out".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { readManifest } from '../lib/manifest.mjs';
import { checkForUpdate, findInstallRoot } from '../lib/updatecheck.mjs';

/** The whole hook, lookup included. The same ceiling session-standup.mjs keeps. */
const BUDGET_MS = 3000;

/**
 * The session events worth a notice. `compact` is absent for the reason
 * session-standup.mjs gives: it can happen many times in one session.
 */
const GREETED = new Set(['startup', 'resume', 'clear']);

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

async function main() {
  if (!GREETED.has(sourceFromStdin())) return;

  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

  let loaded;
  try {
    loaded = loadConfig({ dir: projectDir });
  } catch {
    return;
  }
  // No config file: /dev-init has not run, and .claude/settings.json is shared
  // ground — this stays silent rather than advertising.
  if (!loaded.file) return;
  if (loaded.config?.hooks?.updateCheck === false) return;

  // The install root is not always the config's root; the same walk `version`
  // and the command banner do, so all three answer about the same install.
  const root = findInstallRoot(projectDir) ?? loaded.root;
  const installed = readManifest(root)?.installation?.version ?? null;

  // `announceOnce: false`: a greeting says it every session the project is
  // behind, from the cache. It still records the announcement, so the
  // commands run in this session do not say it again.
  const text = await checkForUpdate({ root, installed, announceOnce: false });
  if (text) process.stdout.write(`${text}\n`);
}

// The ceiling on everything, and no exit code but zero. `unref` so a fast run
// is not held open by its own timer.
setTimeout(() => process.exit(0), BUDGET_MS).unref();

main()
  .catch(() => {
    /* a notice is never worth a broken session */
  })
  .finally(() => process.exit(0));
