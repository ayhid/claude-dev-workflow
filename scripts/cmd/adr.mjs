/**
 * Architecture decision records: create, freeze, supersede, index.
 *
 *   dev.mjs adr new "Worktrees by default"       scaffold 0007-…, status proposed
 *   dev.mjs adr accept 7                         freeze it — the hook guards it from here
 *   dev.mjs adr reject 7                         argued and turned down; the record stays
 *   dev.mjs adr supersede 7 "Branches by default"  new record, links written both ways
 *   dev.mjs adr list                             every record, sorted, with its status
 *   dev.mjs adr index                            regenerate README.md in the decisions dir
 *
 * The two-step — `new` scaffolds, `accept` freezes — is the whole design, not
 * ceremony. A record is editable while it is `proposed`, which is when the
 * skill is still filling in *Options considered* with you. `accept` is the
 * moment it becomes history, and `hooks/check-adr-immutable.sh` refuses edits
 * from then on. Without the two steps the guard would have to choose between
 * blocking the author mid-sentence and never blocking at all.
 *
 * All I/O lives here; every rule about numbering, linking and rendering is in
 * `lib/adr.mjs` and tested without a filesystem.
 *
 * No network. This writes markdown into the project's own docs directory —
 * user content, written because the user asked for it, which is why it sits
 * outside the installer's `_dev-workflow/` boundary and must never be written
 * by the installer itself.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  adrFilename,
  nextNumber,
  parseAdr,
  parseAdrFilename,
  renderAdr,
  renderIndex,
  withStatus,
} from '../../lib/adr.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { UserError } from './common.mjs';

const INDEX_FILE = 'README.md';

export async function run(argv) {
  // `--dir` is a global for this command, so it is pulled out before the
  // subcommand is read: the usage line presents it as one, and a flag that
  // works after the verb but not before it is a papercut nobody remembers.
  const { flag: dirFlag, argv: args } = takeFlag(argv, '--dir');

  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') return usage();

  const { config, root } = loadConfig();
  const dirRel = dirFlag ?? config.docs?.decisionsDir ?? 'docs/decisions';
  const dir = resolve(root, dirRel);

  switch (sub) {
    case 'new':
      return cmdNew({ dir, dirRel, argv: rest });
    case 'accept':
      return cmdSetStatus({ dir, dirRel, argv: rest, status: 'accepted' });
    case 'reject':
      return cmdSetStatus({ dir, dirRel, argv: rest, status: 'rejected' });
    case 'supersede':
      return cmdSupersede({ dir, dirRel, argv: rest });
    case 'list':
      return cmdList({ dir, dirRel });
    case 'index':
      return cmdIndex({ dir, dirRel });
    default:
      throw new UserError(`unknown adr subcommand '${sub}'\n\n${USAGE}`);
  }
}

const USAGE = `usage: dev.mjs adr <subcommand>

  new <TITLE> [--deciders WHO] [--date YYYY-MM-DD]   scaffold the next record
  accept <N>                                         freeze it; the hook guards it
  reject <N>                                         argued and turned down
  supersede <N> <TITLE> [--deciders WHO]             replace N, link both ways
  list                                               every record and its status
  index                                              regenerate the index file

  --dir PATH   override docs.decisionsDir for one run`;

function usage() {
  process.stdout.write(`${USAGE}\n`);
}

/** Lift `--name value` out of argv, wherever it sits, and return the rest. */
function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { flag: null, argv };
  const value = i + 1 < argv.length ? argv[i + 1] : null;
  if (value === null) throw new UserError(`${name} needs a value`);
  return { flag: value, argv: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

/** Flags are `--name value`; everything else is positional. */
function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      i += 1; // skip its value
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

/** Today, as ISO-8601. Injectable so a test never has to freeze the clock. */
function today(argv) {
  const given = opt(argv, '--date');
  if (given) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new UserError(`--date must be YYYY-MM-DD, got '${given}'`);
    return given;
  }
  return new Date().toISOString().slice(0, 10);
}

/** Every ADR in the directory, parsed. The index file is not one of them. */
function readAll(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!parseAdrFilename(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    out.push({ ...parseAdr(text, name), text });
  }
  return out.sort((a, b) => a.number - b.number);
}

function findByNumber(all, n, dirRel) {
  const num = Number(n);
  if (!Number.isInteger(num)) throw new UserError(`'${n}' is not a record number`);
  const found = all.find((a) => a.number === num);
  if (!found) {
    const known = all.map((a) => a.number).join(', ') || 'none';
    throw new UserError(`no record ${num} in ${dirRel} (found: ${known})`);
  }
  return found;
}

/** Rewrite the index. Called after every write so it is never stale. */
function writeIndex(dir, dirRel) {
  const all = readAll(dir);
  const path = join(dir, INDEX_FILE);
  writeFileSync(path, renderIndex(all), 'utf8');
  return `${dirRel}/${INDEX_FILE}`;
}

function cmdNew({ dir, dirRel, argv }) {
  const title = positionals(argv).join(' ').trim();
  if (!title) throw new UserError('dev.mjs adr new "<title>" — a record needs a title');

  mkdirSync(dir, { recursive: true });
  const all = readAll(dir);
  const number = nextNumber(all.map((a) => a.number));
  const file = adrFilename(number, title);
  const text = renderAdr({
    number,
    title,
    date: today(argv),
    deciders: opt(argv, '--deciders'),
    status: 'proposed',
  });
  writeFileSync(join(dir, file), text, 'utf8');
  const index = writeIndex(dir, dirRel);

  process.stdout.write(
    [
      `created: ${dirRel}/${file}`,
      `status:  proposed — editable until 'dev.mjs adr accept ${number}'`,
      `index:   ${index}`,
      '',
      'Fill in Context, Options considered and Consequences, then accept it.',
      '',
    ].join('\n'),
  );
}

function cmdSetStatus({ dir, dirRel, argv, status }) {
  const all = readAll(dir);
  const target = findByNumber(all, positionals(argv)[0], dirRel);
  if (target.status === status) {
    process.stdout.write(`${dirRel}/${target.file} is already ${status} — nothing to do\n`);
    return;
  }
  if (target.status === 'superseded') {
    throw new UserError(
      `record ${target.number} is superseded by ${target.supersededBy?.number ?? '?'} — ` +
        'a superseded record is history and does not change status again',
    );
  }
  writeFileSync(join(dir, target.file), withStatus(target.text, status), 'utf8');
  const index = writeIndex(dir, dirRel);
  process.stdout.write(
    [
      `${status}: ${dirRel}/${target.file}`,
      status === 'accepted'
        ? `guarded: edits are now refused — use 'dev.mjs adr supersede ${target.number} "<title>"'`
        : `status:  ${status}`,
      `index:   ${index}`,
      '',
    ].join('\n'),
  );
}

function cmdSupersede({ dir, dirRel, argv }) {
  const pos = positionals(argv);
  const all = readAll(dir);
  const old = findByNumber(all, pos[0], dirRel);
  const title = pos.slice(1).join(' ').trim();
  if (!title) throw new UserError('dev.mjs adr supersede <N> "<title>" — the new record needs a title');
  if (old.status === 'superseded') {
    throw new UserError(
      `record ${old.number} is already superseded by ${old.supersededBy?.number ?? '?'}`,
    );
  }

  const number = nextNumber(all.map((a) => a.number));
  const file = adrFilename(number, title);

  // The new record is written first. If the second write fails, the worst
  // outcome is a new record whose predecessor still says `accepted` — visible,
  // and fixable by re-running. The reverse order would leave the old record
  // pointing at a file that does not exist.
  writeFileSync(
    join(dir, file),
    renderAdr({
      number,
      title,
      date: today(argv),
      deciders: opt(argv, '--deciders'),
      status: 'proposed',
      supersedes: { number: old.number, file: old.file },
    }),
    'utf8',
  );
  writeFileSync(
    join(dir, old.file),
    withStatus(old.text, 'superseded', { supersededBy: { number, file } }),
    'utf8',
  );
  const index = writeIndex(dir, dirRel);

  process.stdout.write(
    [
      `created:    ${dirRel}/${file}  (supersedes ${old.number})`,
      `superseded: ${dirRel}/${old.file}  (now points at ${number})`,
      `index:      ${index}`,
      '',
      `Fill it in, then 'dev.mjs adr accept ${number}'.`,
      '',
    ].join('\n'),
  );
}

function cmdList({ dir, dirRel }) {
  const all = readAll(dir);
  if (!all.length) {
    process.stdout.write(`no decision records in ${dirRel}\n`);
    return;
  }
  const lines = [`${'#'.padEnd(6)}${'STATUS'.padEnd(28)}${'DATE'.padEnd(12)}TITLE`];
  lines.push('-'.repeat(78));
  for (const a of all) {
    const status =
      a.status === 'superseded' && a.supersededBy
        ? `superseded by ${String(a.supersededBy.number).padStart(4, '0')}`
        : (a.status ?? '—');
    lines.push(
      String(a.number).padStart(4, '0').padEnd(6) +
        status.padEnd(28) +
        (a.date ?? '—').padEnd(12) +
        (a.title ?? '—'),
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdIndex({ dir, dirRel }) {
  if (!existsSync(dir)) throw new UserError(`no such directory: ${dirRel}`);
  const index = writeIndex(dir, dirRel);
  process.stdout.write(`wrote ${index}\n`);
}
