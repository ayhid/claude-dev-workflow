/**
 * What this project already enforces, and what it merely states.
 *
 *   dev.mjs rules [--repo PATH] [--json]
 *
 * The inventory `/dev-lint-rules` starts from. It reports and never writes: a
 * rule switched on changes what CI does, and that is the user's decision (the
 * skill's first refusal).
 *
 * It is a command rather than a table in the skill for the reason CLAUDE.md
 * gives for the metrics wrapper and the `git()` choke point — cost is context
 * multiplied by turns, so work a command can hand over in one turn should not
 * be a list of file-existence checks the model walks every session. It also
 * makes the skill's second acceptance criterion a guarantee instead of an
 * instruction: nothing already configured can be proposed again if the
 * configured set is read mechanically.
 *
 * No tracker and no network — `loadConfig()` directly, like `docs`, so it runs
 * without a token.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../../lib/config.mjs';
import { detectLinters, languagesOf, renderRules, statedSources } from '../../lib/rules.mjs';
import { sh } from '../../lib/sh.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { resolveRepo, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

const USAGE = 'usage: dev.mjs rules [--repo PATH] [--json]';

function parseArgs(argv) {
  const opts = { json: false, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--repo') opts.repo = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new UserError(`unknown argument '${a}'\n\n${USAGE}`);
  }
  return opts;
}

/** Tracked files only, so an ignored `node_modules` never has to be excluded. */
async function trackedFiles(dir, run) {
  const r = await run('git', ['-C', dir, 'ls-files']);
  return r.ok && r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
}

/**
 * The ledger's claims, or none.
 *
 * A project with no documentation ledger is the normal case, not an error —
 * `/dev-ingest-docs` may simply never have been run here.
 */
function ledgerClaims(root) {
  const path = join(root, ARTIFACT_DIR, LEDGER);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.claims) ? parsed.claims : [];
  } catch {
    // A half-written ledger is somebody else's problem to report; here it just
    // contributes nothing rather than failing the inventory.
    return [];
  }
}

export async function run(argv, { run: runner = sh } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { config, root } = loadConfig();
  const configured = resolveRepo(config, root, opts.repo);
  const dir = configured.dir;

  const files = await trackedFiles(dir, runner);
  const read = (path) => {
    try {
      return readFileSync(join(dir, path), 'utf8');
    } catch {
      return null;
    }
  };

  const repo = config.repos?.find((r) => r.path === configured.path);
  const input = {
    linters: detectLinters({ files, read }),
    checks: repo?.checks ?? [],
    sources: statedSources(files),
    claims: ledgerClaims(root),
    languages: languagesOf(files),
  };

  if (opts.json) {
    // The recipes go out with the rest: an agent reading this should not have
    // to know the table to produce a violation count.
    process.stdout.write(`${JSON.stringify({ repo: configured.path, ...input }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`repo:     ${configured.path} (${dir})\n\n${renderRules(input)}`);
  return 0;
}
