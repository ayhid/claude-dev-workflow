/**
 * Create an issue, or check for duplicates before doing so.
 *
 *   dev.mjs create "<summary>" "<description>|@FILE" [TYPE] [PRIORITY] [--allow-duplicate]
 *   dev.mjs create --dup-check "<keywords>"
 *   dev.mjs create [--allow-duplicate] -- "<summary>" ...
 *
 * `--` ends the flags. A summary is free text, and one that begins with a
 * dash — a bug titled after the flag that is broken — is exactly what this
 * tracker files; without the separator it would read as an unknown flag.
 *
 * stdout carries the new issue ID and nothing else, so a caller can capture it
 * directly; every confirmation and warning goes to stderr. Type and Priority
 * are best-effort — the issue existing matters more than its fields, and losing
 * the ID to a field error would be the worse outcome.
 *
 * ## The duplicate scan runs here, on every file (#47)
 *
 * `--dup-check` existed and worked, and nothing ran it: the skills asked the
 * model to remember a separate command, so it was skipped exactly when a
 * session was busy — which is when duplicates get filed. Filing is one command,
 * and it is the choke point that already exists, so the scan lives in it.
 *
 * Before anything is written, the summary is reduced to keywords
 * (`dupKeywords`) and the open issues are searched. A match refuses: the
 * candidates go to stdout in the same format `--dup-check` prints, stderr names
 * `--allow-duplicate`, the exit code is 2, and nothing is filed. The override
 * files and says on stderr what it matched, so filing a duplicate is an
 * explicit act rather than an omission — but a cheap one, because a genuinely
 * new issue that shares words with an old one is common.
 *
 * The scan may never become a new way for filing to fail. A backend that cannot
 * search, or a search that errors, warns on stderr and files.
 *
 * There is exactly one matcher: `findDuplicates` serves `--dup-check` and the
 * filing path alike, and `renderCandidates` prints for both.
 *
 * Exit codes: 1 is usage or a failed write (thrown, like every command); 2 is
 * "refused as a duplicate", so a caller can tell the two apart.
 */
import { context, readArg, takeValue, UserError } from './common.mjs';

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

/**
 * Words that carry no signal in an issue title. A summary is mostly these, and
 * a search made of them matches everything or nothing.
 */
export const DUP_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'when', 'that', 'this', 'from', 'into', 'onto',
  'not', 'are', 'but', 'can', 'does', 'did', 'should', 'would', 'could', 'still',
  'only', 'also', 'than', 'then', 'its', 'was', 'were', 'has', 'have', 'had',
  'will', 'all', 'any', 'one', 'two', 'our', 'out', 'off', 'per', 'via', 'use',
  'used', 'uses', 'using', 'get', 'gets', 'set', 'sets', 'make', 'makes', 'made',
  'add', 'adds', 'fix', 'fixes', 'bug', 'issue', 'error', 'fail', 'fails',
  'failed', 'work', 'works', 'working', 'how', 'why', 'what', 'which', 'who',
  'where', 'after', 'before', 'about', 'over', 'under', 'some', 'more', 'most',
  'very', 'just', 'like', 'being', 'been', 'own', 'you', 'your', 'they', 'them',
  'their', 'there', 'here', 'each', 'every', 'both', 'same', 'other', 'because',
  'while', 'never', 'always', 'already', 'instead', 'rather', 'again', 'once',
  'too', 'yet', 'ever', 'may', 'might', 'must', 'shall', 'cannot', 'wrong',
  'new', 'old', 'even', 'much', 'many', 'else', 'since', 'until', 'though',
  'although', 'without', 'within', 'between', 'through', 'during', 'against',
]);

/**
 * The search keywords a summary becomes.
 *
 * Pure, and exported: the derivation is the only part of the scan a caller
 * cannot see happen, so it is pinned by tests rather than trusted.
 *
 * Lowercased, split on non-word characters (keeping `-`, `.` and `:` inside a
 * token so `dev.mjs` survives), then each token loses a leading `-` or `.` and
 * every `:` — on GitHub those are search operators, and a title fragment must
 * not become a negation or a qualifier. Tokens under three characters and the
 * stopwords are dropped, the rest deduped in first-seen order and capped at
 * `max`. A summary nothing survives from falls back to itself, whole: a scan
 * that searches for nothing would match nothing, silently.
 *
 * @param {string} summary
 * @param {{max?: number}} [opts]
 * @returns {string[]}
 */
export function dupKeywords(summary, { max = 6 } = {}) {
  const raw = String(summary ?? '').trim();
  if (!raw) return [];

  const out = [];
  for (const token of raw.toLowerCase().split(/[^\p{L}\p{N}_.:-]+/u)) {
    const t = token.replace(/^[-.]+/, '').replace(/:/g, '');
    if (t.length < 3 || DUP_STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === max) break;
  }
  return out.length ? out : [raw];
}

/**
 * The one matcher. `--dup-check` and the filing path both come through here,
 * so there is exactly one answer to "is this a duplicate" in the codebase.
 *
 * Capabilities, not the provider name: a backend that cannot search by keyword
 * says so, and this refuses to ask it rather than guess at an empty answer.
 *
 * @returns {Promise<{ok: true, data: Array<{id: string, title: string, url?: string}>} | {ok: false, error: string}>}
 */
export async function findDuplicates(provider, keywords) {
  if (!provider.capabilities.freeTextSearch) {
    return { ok: false, error: `${provider.name} cannot search issues by keyword` };
  }
  return provider.search(keywords);
}

/**
 * The candidates as `--dup-check` has always printed them: one `id<TAB>title`
 * per line, or the one line skills/dev-init reads as "credentials work".
 */
export function renderCandidates(rows) {
  return rows.length
    ? `${rows.map((i) => `${i.id}\t${i.title}`).join('\n')}\n`
    : 'no open issues matched\n';
}

export function parseArgs(args) {
  const opts = { allowDuplicate: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    } else if (a === '--allow-duplicate') opts.allowDuplicate = true;
    else if (a === '--dup-check') opts.dupCheck = takeValue(args, ++i, a);
    else if (a.startsWith('-')) {
      throw new UserError(`unknown flag ${a} — a summary or description that starts with a dash goes after \`--\``);
    } else rest.push(a);
  }
  return { opts, rest };
}

const USAGE =
  'usage: dev.mjs create "<summary>" "<description>|@FILE" [TYPE] [PRIORITY] [--allow-duplicate]\n' +
  '       dev.mjs create --dup-check "<keywords>"\n' +
  '       (a summary that starts with a dash goes after --)';

export async function run(args) {
  const { opts, rest } = parseArgs(args);

  if (opts.dupCheck !== undefined) {
    const { provider } = await context();
    const r = await findDuplicates(provider, opts.dupCheck);
    if (!r.ok) throw new UserError(r.error);
    process.stdout.write(renderCandidates(r.data));
    return 0;
  }

  const [summary, rawDescription, type = 'Bug', priority = ''] = rest;
  // Whether the caller *chose* a type, as opposed to falling into the default.
  // Only an explicit one is worth warning about when the backend has no types:
  // warning about our own default would fire on every create.
  const typeWasGiven = rest[2] !== undefined;
  // Trimmed: '   ' is truthy, and would reach the scan as an empty query,
  // which a search backend reads as "no filter" and matches everything.
  if (!summary?.trim() || rawDescription === undefined) throw new UserError(USAGE);

  const description = readArg(rawDescription, 'description file');
  const { provider } = await context();

  // Capabilities, not the provider name: a backend that cannot store a field
  // should say so once here rather than have every caller learn which ones can.
  for (const w of unsupportedFieldWarnings(provider, { type, typeWasGiven, priority })) {
    process.stderr.write(`dev create: ${w}\n`);
  }

  // The scan, before the write. Skipped — never refused — when it cannot run:
  // the check may not become a new way for filing to fail.
  const keywords = dupKeywords(summary).join(' ');
  const scan = await findDuplicates(provider, keywords);
  if (!scan.ok) {
    process.stderr.write(`dev create: duplicate scan skipped — ${scan.error}\n`);
  } else if (scan.data.length && !opts.allowDuplicate) {
    process.stdout.write(renderCandidates(scan.data));
    process.stderr.write(
      `dev create: refused — ${scan.data.length} open issue(s) match "${keywords}" ` +
        `(${scan.data.map((i) => i.id).join(', ')}); nothing was filed. ` +
        'Re-run with --allow-duplicate if this is genuinely new.\n',
    );
    return 2;
  } else if (scan.data.length) {
    process.stderr.write(
      `dev create: duplicate check overridden — matched ${scan.data.map((i) => i.id).join(', ')}\n`,
    );
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
