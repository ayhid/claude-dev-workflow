/**
 * Print the effective workflow config so a skill can read it in one call.
 *
 *   dev.mjs config          human-readable summary
 *   dev.mjs config --json   merged JSON, defaults filled in
 *
 * Every field has a default, so this succeeds with no .dev-workflow.json at all —
 * except baseUrl, which has none and is reported as missing rather than fatal.
 * It also needs no token: a skill calls this first, to find out whether the
 * project is configured at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatConfig, loadConfig } from '../../lib/config.mjs';
import { emitUpdateBanner } from './common.mjs';

export async function run(args) {
  const { config, file, root } = loadConfig();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  } else {
    // The notes file is read here rather than in formatConfig: that function is
    // pure and is called from tests with no filesystem. A missing file is the
    // normal case for a project that has never run `dev.mjs note`, so it is an
    // empty string, never an error.
    const notesPath = resolve(root, config.notesFile ?? '');
    const notes = config.notesFile && existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';

    process.stdout.write(`${formatConfig(config, file, notes)}\n`);
  }

  // After stdout, and on stderr: `--json` is parsed by skills, and the two
  // branches above must print exactly what they printed before this existed.
  await emitUpdateBanner(root);
  return 0;
}
