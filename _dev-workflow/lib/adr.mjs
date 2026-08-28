/**
 * Architecture decision records: numbering them, rendering them, and reading
 * one back out of its own text.
 *
 * Pure — no fs, no argv, no clock beyond what a caller passes in.
 * `scripts/cmd/adr.mjs` does the I/O, the same split as `lib/branch.mjs` /
 * `lib/vcs.mjs`: the numbering and linking rules are the part worth testing,
 * and they are testable here without a filesystem or a directory of fixtures.
 *
 * The format is MADR trimmed to the three sections that carry weight, because
 * the reason an ADR beats a commit message is *Options considered* — the
 * alternatives that were rejected and why. Nygard's original template does not
 * force that section, and unforced it does not get written.
 *
 * Two rules the rest of this file exists to enforce:
 *
 * 1. **A number is never reused.** It is a permanent address, cited from code
 *    comments and from other ADRs. `nextNumber` counts from the highest number
 *    ever seen, not from the count of files, so deleting 0003 does not hand
 *    0003 to the next record and silently reparent every citation of it.
 * 2. **An accepted record is never edited.** It is superseded, and the link is
 *    written in *both* directions — forwards so a reader of the old record
 *    finds the new one, backwards so a reader of the new one can see what it
 *    replaced. A one-way link makes the older record a dead end, which is the
 *    failure this whole file is trying to avoid.
 */
import { slugify } from './branch.mjs';

/**
 * The status lifecycle, and it stays this small on purpose.
 *
 * `rejected` is kept rather than deleted: a proposal that was argued and turned
 * down is a record of an argument already had, and throwing it away invites the
 * argument again. `superseded` is the only status that carries a pointer.
 */
export const ADR_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'];

/** How wide a number is rendered. Four digits sorts lexicographically to 9999. */
const WIDTH = 4;

/** `0007-worktrees-by-default.md` → `{ number: 7, slug: 'worktrees-by-default' }`. */
export function parseAdrFilename(name) {
  const m = /^(\d{1,10})-([^/]*)\.md$/i.exec(String(name ?? '').trim());
  if (!m) return null;
  return { number: Number(m[1]), slug: m[2] };
}

/** `7` → `'0007'`. Numbers past the pad width simply get wider. */
export function padNumber(n) {
  return String(Math.trunc(Number(n))).padStart(WIDTH, '0');
}

/**
 * The next number to hand out.
 *
 * Highest seen plus one — see rule 1 above. An empty directory starts at 1, not
 * 0: `0000` reads as "unnumbered" to everyone who has ever seen an ADR set.
 */
export function nextNumber(existing = []) {
  const nums = existing
    .map((e) => (typeof e === 'number' ? e : parseAdrFilename(e)?.number))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/** `adrFilename(7, 'Worktrees by default')` → `0007-worktrees-by-default.md`. */
export function adrFilename(number, title) {
  const slug = slugify(title, { maxWords: 6 }) || 'untitled';
  return `${padNumber(number)}-${slug}.md`;
}

/**
 * The header line a status is written on.
 *
 * One line, one shape, no variants — `hooks/check-adr-immutable.sh` matches it
 * with a POSIX ERE from bash, so a format only a markdown parser could read
 * would mean the guard and the writer disagreeing about what "accepted" looks
 * like. That is the drift this repo refuses everywhere else.
 */
function statusLine(status, supersededBy) {
  if (status === 'superseded' && supersededBy) {
    const { number, file } = supersededBy;
    return `- Status: superseded by [${padNumber(number)}](${file})`;
  }
  return `- Status: ${status}`;
}

/** Read the status back out of an ADR's text. Returns null if there is no header. */
export function statusOf(text) {
  const m = /^-[ \t]+Status:[ \t]+([a-z]+)/im.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** Read the whole header back: number, title, status, date, and either link. */
export function parseAdr(text, filename = null) {
  const s = String(text ?? '');
  const titleM = /^#[ \t]+(\d{1,10})\.[ \t]+(.+?)[ \t]*$/m.exec(s);
  const fromName = filename ? parseAdrFilename(filename) : null;
  const supersededM = /^-[ \t]+Status:[ \t]+superseded by[ \t]+\[(\d+)\]\(([^)]*)\)/im.exec(s);
  const supersedesM = /^-[ \t]+Supersedes:[ \t]+\[(\d+)\]\(([^)]*)\)/im.exec(s);
  const dateM = /^-[ \t]+Date:[ \t]+(\d{4}-\d{2}-\d{2})/im.exec(s);
  const decidersM = /^-[ \t]+Deciders:[ \t]+(.+?)[ \t]*$/im.exec(s);

  return {
    number: titleM ? Number(titleM[1]) : (fromName?.number ?? null),
    title: titleM ? titleM[2] : null,
    status: statusOf(s),
    date: dateM ? dateM[1] : null,
    deciders: decidersM ? decidersM[1] : null,
    supersededBy: supersededM ? { number: Number(supersededM[1]), file: supersededM[2] } : null,
    supersedes: supersedesM ? { number: Number(supersedesM[1]), file: supersedesM[2] } : null,
    file: filename ?? null,
  };
}

/**
 * Rewrite only the status line, leaving every other byte alone.
 *
 * This is the one edit an accepted record ever receives, and it is why it is a
 * surgical line replacement rather than a re-render: re-rendering would rewrite
 * prose the author wrote, which is the thing rule 2 forbids. If there is no
 * status line to replace we refuse rather than inventing one — a file with no
 * header is not an ADR, and quietly bolting one on would hide that.
 */
export function withStatus(text, status, { supersededBy = null } = {}) {
  const s = String(text ?? '');
  if (!ADR_STATUSES.includes(status)) {
    throw new Error(`unknown ADR status '${status}' — one of: ${ADR_STATUSES.join(', ')}`);
  }
  if (!/^-[ \t]+Status:/im.test(s)) {
    throw new Error('no "- Status:" line found — this file is not an ADR');
  }
  return s.replace(/^-[ \t]+Status:.*$/im, statusLine(status, supersededBy));
}

/**
 * Render a new ADR.
 *
 * `date` is passed in rather than read from the clock so the same inputs print
 * the same bytes — provider.mjs rule 4, and the reason the tests do not need to
 * freeze time.
 */
export function renderAdr({
  number,
  title,
  date,
  deciders = null,
  status = 'proposed',
  supersedes = null,
  context = null,
  options = [],
  consequences = null,
} = {}) {
  if (!Number.isInteger(number) || number < 0) throw new Error('renderAdr needs an integer number');
  if (!String(title ?? '').trim()) throw new Error('renderAdr needs a title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) {
    throw new Error('renderAdr needs an ISO-8601 date (YYYY-MM-DD)');
  }
  if (!ADR_STATUSES.includes(status)) {
    throw new Error(`unknown ADR status '${status}' — one of: ${ADR_STATUSES.join(', ')}`);
  }

  const L = [];
  L.push(`# ${padNumber(number)}. ${String(title).trim()}`);
  L.push('');
  L.push(statusLine(status, null));
  L.push(`- Date: ${date}`);
  if (deciders) L.push(`- Deciders: ${deciders}`);
  if (supersedes) {
    L.push(`- Supersedes: [${padNumber(supersedes.number)}](${supersedes.file})`);
  }
  L.push('');
  L.push('## Context');
  L.push('');
  L.push(context || 'What forced a decision. The constraint, not the history.');
  L.push('');
  L.push('## Options considered');
  L.push('');
  if (options.length) {
    for (const o of options) {
      const label = typeof o === 'string' ? o : o.label;
      const why = typeof o === 'string' ? null : o.why;
      const chosen = typeof o === 'object' && o.chosen ? ' **(chosen)**' : '';
      L.push(`- **${label}**${chosen}${why ? ` — ${why}` : ''}`);
    }
  } else {
    L.push('- **<option>** — why not.');
    L.push('- **<option>** — why not.');
    L.push('- **<chosen option>** — why yes.');
  }
  L.push('');
  L.push('## Consequences');
  L.push('');
  L.push(consequences || 'What this makes easy, what it makes expensive, what it forecloses.');
  L.push('');
  return L.join('\n');
}

/**
 * The generated index.
 *
 * Deliberately a plain markdown table: it has to render on GitHub and in a PR
 * diff, which a Dataview query does not. Obsidian users get a live query in
 * their own vault; everyone else gets this file, and the two do not compete
 * because only this one is committed.
 *
 * Sorted by number ascending — stable output, same bytes for the same inputs.
 */
export function renderIndex(adrs = [], { title = 'Decisions' } = {}) {
  const rows = [...adrs]
    .filter((a) => Number.isInteger(a?.number))
    .sort((a, b) => a.number - b.number);

  const L = [];
  L.push(`# ${title}`);
  L.push('');
  L.push('<!-- Generated by `dev.mjs adr index`. Edits here are overwritten. -->');
  L.push('');
  if (!rows.length) {
    L.push('No decision records yet. `dev.mjs adr new "<title>"` writes the first.');
    L.push('');
    return L.join('\n');
  }
  L.push('| # | Title | Status | Date |');
  L.push('| --- | --- | --- | --- |');
  for (const a of rows) {
    const num = padNumber(a.number);
    const link = a.file ? `[${num}](${a.file})` : num;
    let status = a.status ?? '—';
    if (a.status === 'superseded' && a.supersededBy) {
      const by = padNumber(a.supersededBy.number);
      status = `superseded by [${by}](${a.supersededBy.file})`;
    }
    L.push(`| ${link} | ${a.title ?? '—'} | ${status} | ${a.date ?? '—'} |`);
  }
  L.push('');
  return L.join('\n');
}
