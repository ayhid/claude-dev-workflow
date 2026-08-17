/**
 * Durable project knowledge: the decisions of it, with no IO.
 *
 * The thing being solved is that what a session learns dies with the session.
 * The config's `notes` array already proved the need — it is shown to the model
 * on every skill run — but it is hand-edited JSON, so nothing can add to it
 * while you work, and prose in a config file stays short and cryptic.
 *
 * Everything here is pure so the format is testable without a repository, and
 * the clock is a parameter for the same reason an adapter takes its transport as
 * one: a function that reads the wall clock cannot be asserted against.
 *
 * The file this renders is a *log*, not a config. It is appended to, never
 * rewritten, so an entry someone wrote by hand is never reformatted or lost.
 */

/** How much of the notes file `dev.mjs config` shows before it starts truncating. */
export const DEFAULT_MAX_CHARS = 4000;

/**
 * One entry, ready to append.
 *
 * The heading carries the date and the issue the work was under, because that
 * provenance is the whole point: "we learned this while doing #22" is what makes
 * a note trustworthy months later. A note taken off a ticket says so rather than
 * inventing an ID — rule 2, no inference.
 *
 * @param {{text: string, id?: string|null, now?: Date}} entry
 */
export function renderEntry({ text, id = null, now = new Date() }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('a note needs some text');

  const date = now.toISOString().slice(0, 10);
  const heading = id ? `## ${date} — ${id}` : `## ${date} — no ticket`;

  return `${heading}\n\n${body}\n`;
}

/**
 * Append `entry` to `existing`, returning the whole file.
 *
 * Separate from `renderEntry` so the spacing rule has one home: exactly one
 * blank line between entries, and a file that did not end in a newline is fixed
 * rather than run together with what follows.
 */
export function appendEntry(existing, entry) {
  const before = String(existing ?? '');
  if (!before.trim()) return entry;
  return `${before.replace(/\n+$/, '')}\n\n${entry}`;
}

/**
 * The entries in a notes file, newest last, as `{heading, date, id, body}`.
 *
 * Anything before the first heading is kept as a leading entry with a null
 * heading: a user may well put a paragraph at the top of the file explaining
 * what it is for, and dropping it silently would be the sort of quiet data loss
 * this codebase refuses everywhere else.
 */
export function parseNotes(markdown) {
  const text = String(markdown ?? '');
  if (!text.trim()) return [];

  const lines = text.split('\n');
  const entries = [];
  let current = { heading: null, date: null, id: null, lines: [] };

  const push = () => {
    const body = current.lines.join('\n').trim();
    if (current.heading || body) {
      entries.push({ heading: current.heading, date: current.date, id: current.id, body });
    }
  };

  for (const line of lines) {
    // Either dash: entries this tool writes use an em dash, but the file is
    // meant to be edited by hand too, and a hyphen there is not a mistake worth
    // dropping someone's note over.
    const m = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+(.*)$/.exec(line);
    if (m) {
      push();
      const who = m[2].trim();
      current = {
        heading: line,
        date: m[1],
        id: who === 'no ticket' ? null : who,
        lines: [],
      };
    } else {
      current.lines.push(line);
    }
  }
  push();

  return entries;
}

/**
 * What `dev.mjs config` should print for notes.
 *
 * Two sources, deliberately: the inline `notes` array every existing project
 * already has, then the file. The array is not migrated and not rewritten —
 * nothing here touches a user's config — so both must render.
 *
 * Truncation keeps the **newest** entries, because the recent ones are the ones
 * a session is likely to need, and it always says what it dropped and where to
 * read it. Silently hiding knowledge would be worse than printing too much,
 * which is the failure this whole feature exists to prevent.
 *
 * @param {{inline?: string[]|string, file?: string|null, path?: string|null, maxChars?: number}} sources
 * @returns {{lines: string[], truncated: number}}
 */
export function mergeForDisplay({ inline, file, path = null, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const lines = [];

  const inlineNotes = inline ? (Array.isArray(inline) ? inline : [inline]) : [];
  for (const n of inlineNotes) lines.push(`  - ${n}`);

  const entries = parseNotes(file);
  if (!entries.length) {
    if (!inlineNotes.length) lines.push('  (none)');
    return { lines, truncated: 0 };
  }

  // Fill from the newest backwards, then reverse: the output stays in reading
  // order while the budget is spent on what is most likely to matter.
  const kept = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const rendered = renderedLines(entries[i]);
    const cost = rendered.join('\n').length;
    if (kept.length && used + cost > maxChars) break;
    kept.unshift(rendered);
    used += cost;
  }

  const truncated = entries.length - kept.length;
  if (truncated > 0) {
    lines.push(
      `  (${truncated} older ${truncated === 1 ? 'entry' : 'entries'} not shown — read ${path ?? 'the notes file'})`,
    );
  }
  for (const rendered of kept) lines.push(...rendered);

  return { lines, truncated };
}

/** One parsed entry as indented display lines. */
function renderedLines(entry) {
  const out = [];
  if (entry.heading) out.push(`  ${entry.heading.replace(/^##\s+/, '')}`);
  for (const line of entry.body.split('\n')) out.push(line ? `    ${line}` : '');
  return out;
}
