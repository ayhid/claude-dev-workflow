#!/usr/bin/env node
/**
 * The runtime CLI the skills call.
 *
 *   yt.mjs config [--json]                       effective config
 *   yt.mjs fetch  ABC-22                         issue as markdown, comments included
 *   yt.mjs update ABC-22 "State In Progress"     apply a command, read the state back
 *   yt.mjs update ABC-22 comment "note"          comment only
 *   yt.mjs create --dup-check "slug 500 router"  open issues matching keywords
 *   yt.mjs create "Summary" @/tmp/body.md Bug Major
 *   yt.mjs sync [--apply] [--since 14d] [--deep] reconcile states against GitHub
 *
 * This file must stay dependency-free at its top level: it is the entry point
 * that has to be able to report a missing dependency. Commands are imported
 * lazily so only the one being run pays for what it needs.
 */
import { ensureDeps } from './bootstrap.mjs';

const USAGE = `usage: yt.mjs <command> [args]

  config [--json]                       print the effective workflow config
  fetch  <ISSUE-ID>                     print an issue as markdown
  update <ISSUE-ID> <COMMAND> [COMMENT] apply a command; COMMAND may be "comment"
  create <SUMMARY> <DESCRIPTION> [TYPE] [PRIORITY]
  create --dup-check <KEYWORDS>         search open issues
  sync   [--apply] [--since 30d] [--repo PATH] [--deep] [--limit N]

Config comes from .youtrack.json (or .claude/youtrack.json), then the
environment. Run /yt-init to create one.`;

/**
 * Commands are plain HTTP unless noted. `sync` drives the GitHub CLI, so it is
 * the only one that needs zx — the rest keep working in a freshly cloned plugin
 * that has no node_modules at all.
 */
const COMMANDS = {
  config: { load: () => import('./cmd/config.mjs'), deps: [] },
  fetch: { load: () => import('./cmd/fetch.mjs'), deps: [] },
  update: { load: () => import('./cmd/update.mjs'), deps: [] },
  create: { load: () => import('./cmd/create.mjs'), deps: [] },
  sync: { load: () => import('./cmd/sync.mjs'), deps: ['zx'] },
};

const [name, ...args] = process.argv.slice(2);

if (!name || name === '-h' || name === '--help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(name ? 0 : 1);
}

const entry = COMMANDS[name];
if (!entry) {
  process.stderr.write(`yt: unknown command '${name}'\n\n${USAGE}\n`);
  process.exit(1);
}

try {
  if (entry.deps.length) await ensureDeps(entry.deps);
  const mod = await entry.load();
  const code = await mod.run(args);
  process.exit(code ?? 0);
} catch (err) {
  process.stderr.write(`yt ${name}: ${err.message}\n`);
  process.exit(1);
}
