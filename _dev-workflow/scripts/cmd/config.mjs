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
import { formatConfig, loadConfig } from '../../lib/config.mjs';

export async function run(args) {
  const { config, file } = loadConfig();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${formatConfig(config, file)}\n`);
  return 0;
}
