/**
 * Create an issue, or check for duplicates before doing so.
 *
 *   dev.mjs create --dup-check "<keywords>"
 *   dev.mjs create "<summary>" "<description>" [TYPE] [PRIORITY]
 *
 * stdout carries the new issue ID and nothing else, so a caller can capture it
 * directly; every confirmation and warning goes to stderr. Type and Priority
 * are best-effort — the issue existing matters more than its fields, and losing
 * the ID to a field error would be the worse outcome.
 */
import { context, readArg, UserError } from './common.mjs';

async function dupCheck(provider, keywords) {
  const r = await provider.search(keywords);
  if (!r.ok) throw new UserError(r.error);
  const rows = r.data;
  process.stdout.write(
    rows.length ? `${rows.map((i) => `${i.id}\t${i.title}`).join('\n')}\n` : 'no open issues matched\n',
  );
  return 0;
}

export async function run(args) {
  if (args[0] === '--dup-check') {
    const keywords = args[1];
    if (!keywords) throw new UserError('usage: dev.mjs create --dup-check "<keywords>"');
    const { provider } = await context({ requireProject: true });
    return dupCheck(provider, keywords);
  }

  const [summary, rawDescription, type = 'Bug', priority = ''] = args;
  if (!summary || rawDescription === undefined) {
    throw new UserError('usage: dev.mjs create "<summary>" "<description>" [TYPE] [PRIORITY]');
  }

  const description = readArg(rawDescription, 'description file');
  const { provider } = await context({ requireProject: true });

  // Capabilities, not the provider name: a backend without ordered priorities
  // should say so once here rather than have every caller learn which ones have
  // them.
  if (priority && !provider.capabilities.priorities) {
    process.stderr.write(`dev create: ${provider.name} has no priorities — ignoring "${priority}"\n`);
  }

  const r = await provider.create({
    summary,
    description,
    type: provider.capabilities.types ? type : undefined,
    priority: provider.capabilities.priorities ? priority : undefined,
  });
  if (!r.ok) throw new UserError(r.error);

  for (const w of r.warnings ?? []) process.stderr.write(`dev create: ${w}\n`);
  if (!(r.warnings ?? []).length) process.stderr.write(`dev create: created ${r.id}\n`);

  process.stdout.write(`${r.id}\n`);
  return 0;
}
