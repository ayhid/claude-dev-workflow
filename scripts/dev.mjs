#!/usr/bin/env node
/**
 * The runtime CLI the skills call.
 *
 *   dev.mjs config [--json]                       effective config
 *   dev.mjs fetch  ABC-22                         issue as markdown, comments included
 *   dev.mjs update ABC-22 state start              move a rung, read the state back
 *   dev.mjs update ABC-22 comment "note"          comment only
 *   dev.mjs create --dup-check "slug 500 router"  open issues matching keywords
 *   dev.mjs create "Summary" @/tmp/body.md Bug Major
 *   dev.mjs start  ABC-22                         branch or worktree + move to start
 *   dev.mjs resume [ABC-22]                       put the working copy back, say what is on it
 *   dev.mjs abandon ABC-22 "why"                  drop the work, walk the ticket back
 *   dev.mjs land   [ABC-22] [--apply]             open a PR, or rebase and push
 *   dev.mjs assess                                greenfield or brownfield, from signals
 *   dev.mjs ingest scan|next|record|answer|emit   absorb a codebase's documentation
 *   dev.mjs adr new|accept|reject|supersede|list|index   decision records
 *   dev.mjs standup [--since 1d]                  what merged, what is in flight, what is stale
 *   dev.mjs sync [--apply] [--since 14d] [--deep] reconcile states against GitHub
 *   dev.mjs version [--upgrade]                   installed vs latest workflow version
 *
 * Nothing here depends on anything outside node: builtins. The installed copy
 * under `_dev-workflow/` has no `node_modules` and must run in any project — a Rust
 * or Python one included. Commands are imported lazily so a run only parses
 * what it needs.
 */
const USAGE = `usage: dev.mjs <command> [args]

  config [--json]                       print the effective workflow config
  fetch  <ISSUE-ID>                     print an issue as markdown
  update <ISSUE-ID> state <start|review|done|abandon|"<ladder state>"> [COMMENT|@FILE] [--criteria C]
  update <ISSUE-ID> comment <TEXT|@FILE>
  update <ISSUE-ID> raw "<command>" [COMMENT|@FILE]   backend-native, where supported
  create <SUMMARY> <DESCRIPTION> [TYPE] [PRIORITY]
  create --dup-check <KEYWORDS>         search open issues
  start  <ISSUE-ID> [--type T] [--mode worktree|branch] [--repo PATH] [--print]
  resume [ISSUE-ID] [--repo PATH] [--print]
  abandon <ISSUE-ID> <REASON|@FILE> [--force] [--repo PATH]
  land   [ISSUE-ID] [--apply] [--repo PATH] [--criteria first-pass|reworked]
  assess [--repo PATH] [--json]         greenfield or brownfield, proposed from signals
  ingest [scan|next|read|record|answer|emit]   absorb existing documentation, in steps
  adr    [new|accept|reject|supersede|list|index]  architecture decision records
  standup [--since 1d] [--stale 7d] [--repo PATH]
  sync   [--apply] [--since 30d] [--repo PATH] [--deep] [--limit N]
  version [--json] [--offline] [--upgrade]

Config comes from .dev-workflow.json (or .claude/dev-workflow.json), then the
environment. Run /dev-init to create one.`;

const COMMANDS = {
  config: () => import('./cmd/config.mjs'),
  fetch: () => import('./cmd/fetch.mjs'),
  update: () => import('./cmd/update.mjs'),
  create: () => import('./cmd/create.mjs'),
  start: () => import('./cmd/start.mjs'),
  resume: () => import('./cmd/resume.mjs'),
  abandon: () => import('./cmd/abandon.mjs'),
  land: () => import('./cmd/land.mjs'),
  assess: () => import('./cmd/assess.mjs'),
  ingest: () => import('./cmd/ingest.mjs'),
  adr: () => import('./cmd/adr.mjs'),
  standup: () => import('./cmd/standup.mjs'),
  sync: () => import('./cmd/sync.mjs'),
  note: () => import('./cmd/note.mjs'),
  status: () => import('./cmd/status.mjs'),
  // `version` reports and, with --upgrade, rewrites the workflow's own files.
  // Not `upgrade`: one letter from `update` above, which writes to the tracker.
  version: () => import('./cmd/version.mjs'),
};

const [name, ...args] = process.argv.slice(2);

if (!name || name === '-h' || name === '--help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(name ? 0 : 1);
}

const load = COMMANDS[name];
if (!load) {
  process.stderr.write(`yt: unknown command '${name}'\n\n${USAGE}\n`);
  process.exit(1);
}

try {
  const mod = await load();
  const code = await mod.run(args);
  process.exit(code ?? 0);
} catch (err) {
  process.stderr.write(`dev ${name}: ${err.message}\n`);
  process.exit(1);
}
