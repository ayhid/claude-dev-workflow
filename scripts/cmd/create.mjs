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

/**
 * Which requested fields this backend cannot store, as warnings to print.
 *
 * Pure, and separated from `run` so it can be tested without a provider or a
 * config on disk. It exists because rule 2 cuts both ways: a field the backend
 * silently drops is exactly the failure the rule is about, and the two fields
 * were not symmetric — priority warned, type did not.
 *
 * Keyed on `capabilities`, never on the provider name, so a third backend is
 * covered here the moment it declares what it supports.
 *
 * @param {{name: string, capabilities: {types: boolean, priorities: boolean}}} provider
 * @param {{type?: string, typeWasGiven?: boolean, priority?: string}} requested
 * @returns {string[]}
 */
export function unsupportedFieldWarnings(provider, requested) {
  const out = [];
  const { type, typeWasGiven, priority } = requested;

  // `typeWasGiven` rather than a truthiness check: `run` defaults the type to
  // `Bug`, so warning on the value alone would fire on every single create
  // against a backend without types — noise that trains people to ignore it.
  if (typeWasGiven && type && !provider.capabilities.types) {
    out.push(`${provider.name} has no issue types — ignoring "${type}"`);
  }
  if (priority && !provider.capabilities.priorities) {
    out.push(`${provider.name} has no priorities — ignoring "${priority}"`);
  }
  return out;
}

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
    const { provider } = await context();
    return dupCheck(provider, keywords);
  }

  const [summary, rawDescription, type = 'Bug', priority = ''] = args;
  // Whether the caller *chose* a type, as opposed to falling into the default.
  // Only an explicit one is worth warning about when the backend has no types:
  // warning about our own default would fire on every create.
  const typeWasGiven = args[2] !== undefined;
  if (!summary || rawDescription === undefined) {
    throw new UserError('usage: dev.mjs create "<summary>" "<description>" [TYPE] [PRIORITY]');
  }

  const description = readArg(rawDescription, 'description file');
  const { provider } = await context();

  // Capabilities, not the provider name: a backend that cannot store a field
  // should say so once here rather than have every caller learn which ones can.
  for (const w of unsupportedFieldWarnings(provider, { type, typeWasGiven, priority })) {
    process.stderr.write(`dev create: ${w}\n`);
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
