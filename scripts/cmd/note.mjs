/**
 * Append durable project knowledge to the project's notes file.
 *
 *   dev.mjs note "sync short-circuits on closed issues — lib/github.mjs:124"
 *   dev.mjs note @/tmp/longer-note.md
 *   dev.mjs note --print                     # where notes live, and how many there are
 *
 * This is for what outlives the ticket: a convention, a trap, why something is
 * the way it is. Working notes about one ticket belong on that ticket —
 * `dev.mjs update <ID> comment` — where they stay attached to the work.
 *
 * The issue ID is read off the current branch rather than asked for, because a
 * note is worth most when it records *while doing what* it was learned, and
 * anything the session has to be prompted for gets skipped.
 *
 * No network: this writes one local file. It works with no token, offline, and
 * on a branch with no ticket.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { issueIdFromBranch } from '../../lib/branch.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { appendEntry, parseNotes, renderEntry } from '../../lib/notes.mjs';
import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { UserError } from './common.mjs';

export async function run(argv) {
  const { config, root } = loadConfig();

  const notesPath = resolve(root, config.notesFile ?? '.dev-workflow.notes.md');
  const existing = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';

  if (argv.includes('--print') || argv.length === 0) {
    return report(notesPath, existing, argv.length === 0);
  }

  // Everything that is not a flag is the note. Joined rather than rejected: an
  // unquoted sentence arrives as several argv entries, and refusing it would be
  // pedantry about shell quoting rather than a real ambiguity.
  const parts = argv.filter((a) => a !== '--print');
  const text = readArgText(parts.join(' '));
  if (!text.trim()) throw new UserError('a note needs some text: dev.mjs note "<what you learned>"');

  const id = await currentIssueId(config, root);
  const entry = renderEntry({ text, id });
  writeFileSync(notesPath, appendEntry(existing, entry), 'utf8');

  const rel = notesPath.startsWith(root) ? notesPath.slice(root.length + 1) : notesPath;
  process.stdout.write(
    `dev note: appended to ${rel}${id ? ` under ${id}` : ' (no ticket on this branch)'}\n`,
  );
  if (!existing) {
    process.stdout.write(`dev note: created it — commit it, it is meant to be shared.\n`);
  }
  return 0;
}

/** `@path` reads a file; a literal `@@` escapes to one `@`. Mirrors readArg in common.mjs. */
function readArgText(value) {
  const v = String(value ?? '');
  if (v.startsWith('@@')) return v.slice(1);
  if (!v.startsWith('@')) return v;

  const path = v.slice(1);
  if (!existsSync(path)) throw new UserError(`no such file: ${path}`);
  return readFileSync(path, 'utf8');
}

/**
 * The ticket this branch is for, or null.
 *
 * Null is a legitimate answer, not a failure: notes are worth taking off a
 * ticket too, and inventing an ID to fill the field would be exactly the kind of
 * guess rule 2 forbids.
 */
async function currentIssueId(config, root) {
  try {
    const vcs = makeVcs({ run: sh });
    const branch = await vcs.currentBranch(root);
    return branch ? issueIdFromBranch(config, branch) : null;
  } catch {
    // A notes file is useful in a directory that is not a git repo at all.
    return null;
  }
}

/** With no arguments, say where notes live and what is in them rather than erroring. */
function report(notesPath, existing, wasBare) {
  const entries = parseNotes(existing);
  process.stdout.write(`file:    ${notesPath}\n`);
  process.stdout.write(`entries: ${entries.length}${existing ? '' : ' (not created yet)'}\n`);
  if (entries.length) {
    const last = entries[entries.length - 1];
    process.stdout.write(`latest:  ${last.date ?? '?'} ${last.id ?? 'no ticket'}\n`);
  }
  if (wasBare) {
    process.stdout.write('\nusage: dev.mjs note "<what you learned>" | @file\n');
  }
  return 0;
}
