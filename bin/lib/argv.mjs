/**
 * The installer's command line, parsed once.
 *
 * Two spellings, one path. `npx claude-dev-workflow@latest --update` was the
 * only form for a long time, and every README line, banner and skill prints it.
 * A binary installed once — `brew install`, `npm install -g` — reads better
 * with a verb: `claude-dev-workflow update`. Both land here and come out as
 * the same `{command, flags}`, so nothing downstream knows which was typed and
 * no documented line ever breaks.
 *
 * Pure: no process, no exit. The caller decides what an error prints.
 */

export const COMMANDS = ['init', 'update', 'version', 'help'];

const VALUE_FLAGS = ['--dir'];
const BOOL_FLAGS = ['--update', '--reconfigure', '--print', '--force', '--help', '-h', '--version'];

/**
 * @param {string[]} argv  everything after the script name
 * @returns {{command: 'init'|'update'|'version'|'help'|'error', error?: string,
 *            flags: {dir: string|null, print: boolean, force: boolean, reconfigure: boolean}}}
 */
export function parseCommand(argv) {
  const flags = { dir: null, print: false, force: false, reconfigure: false };
  let command = null;
  const error = (msg) => ({ command: 'error', error: msg, flags });

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.includes(arg)) {
      // A value is whatever follows, unless it is one of our own flags: a
      // directory called `-workspace` is a legitimate target.
      const value = argv[i + 1];
      if (value === undefined || VALUE_FLAGS.includes(value) || BOOL_FLAGS.includes(value)) return error(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i++;
      continue;
    }
    if (BOOL_FLAGS.includes(arg)) {
      if (arg === '--update') command = command ?? 'update';
      else if (arg === '--help' || arg === '-h') command = 'help';
      else if (arg === '--version') command = 'version';
      else flags[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith('-')) return error(`unknown flag ${arg}`);
    if (command !== null) return error(`unexpected argument "${arg}"`);
    if (!COMMANDS.includes(arg)) return error(`unknown command "${arg}" — one of: ${COMMANDS.join(', ')}`);
    command = arg;
  }

  return { command: command ?? 'init', flags };
}
