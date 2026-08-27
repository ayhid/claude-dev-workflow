/**
 * One line per ticket transition, appended to a local file. No IO here.
 *
 * The thing being solved is that nothing in this workflow remembers. A ticket
 * takes three days or three weeks, gets restarted twice, closes with its
 * criteria met on the first pass or the fourth — and none of it survives the
 * session that did the work. This is the smallest thing that changes that: an
 * append-only log of the transitions that already happen, written locally and
 * sent nowhere.
 *
 * Pure, so the format is asserted without a filesystem and the clock is a
 * parameter (`lib/notes.mjs` for the same reason). The append itself lives in
 * `scripts/cmd/common.mjs`, at the one place every command's `setState` goes
 * through — six call sites would be six places to forget.
 *
 * ## What is recorded, and what is deliberately not
 *
 * Three roles, named by rung and never by a backend's state name: `start`,
 * `done`, `abandon`. Abandoned work is recorded exactly like finished work,
 * because a log that only counts successes answers a question nobody asked.
 *
 * `starts` counts how many times the ticket entered the start rung in the
 * current cycle. It is called that rather than "retries" because that is what
 * it measures — the log can see restarts, and cannot see how many times a test
 * suite was run. `criteria` is the one field the code cannot observe at all: it
 * comes from `/dev-done`, which is the only thing that knows whether the
 * acceptance criteria passed first time, and it is null when nobody said.
 *
 * The file is a log, not a database. It is appended to, never rewritten, and a
 * line nothing can parse is skipped and counted rather than throwing — a
 * corrupt metrics file must never be able to stop a ticket from closing.
 */

/** Where the log goes when a project has not said otherwise. */
export const DEFAULT_METRICS_FILE = '.dev-workflow.metrics.jsonl';

/** The transitions worth a line. Roles, so no backend's state names leak in. */
export const ROLES = ['start', 'done', 'abandon'];

/** The values `--criteria` accepts. Anything else is a typo, and is refused. */
export const CRITERIA = ['first-pass', 'reworked'];

/** Roles that end a cycle: `starts` and `elapsedMs` are measured up to one. */
const CLOSING = new Set(['done', 'abandon']);

/**
 * Which role a state the tracker just reported corresponds to, or null.
 *
 * Keyed off the state that was **read back**, not the rung that was requested:
 * `sync` passes a ladder state rather than a rung, and rule 3 says the state
 * found is the one that happened. A state matching nothing configured — parked
 * in Blocked, moved by hand — is not a transition this log has an opinion
 * about, and null is the honest answer.
 *
 * `done` is tested before `abandon` and `abandon` before `start`, so a project
 * that has pointed two rungs at one state gets the more significant of them
 * rather than whichever happened to be checked first.
 */
export function roleOf(config, state) {
  if (!state) return null;
  const s = config?.states ?? {};
  for (const role of ['done', 'abandon', 'start']) {
    if (s[role] && s[role] === state) return role;
  }
  return null;
}

/**
 * One event, as the JSON line it will be written as.
 *
 * Keys are emitted in a fixed order rather than whatever order they were built
 * in, so the same event always produces the same bytes (contract rule 4) and a
 * diff of two logs is about the events, not the serialiser.
 *
 * @param {{
 *   role: string, id: string, state: string, at?: Date, provider?: string,
 *   elapsedMs?: ?number, starts?: ?number, criteria?: ?string,
 * }} event
 */
export function renderEvent({
  role,
  id,
  state,
  at = new Date(),
  provider = null,
  elapsedMs = null,
  starts = null,
  criteria = null,
}) {
  if (!ROLES.includes(role)) throw new Error(`unknown metrics role "${role}"`);
  if (!id) throw new Error('a metrics event needs an issue ID');

  const line = { at: at.toISOString(), event: role, id, state: state ?? null };
  if (provider) line.provider = provider;

  // Only on a close, and only when known. A zero would read as "measured and
  // it was instant"; null reads as "nobody was there to measure it", which is
  // what an unrecorded start actually means.
  if (CLOSING.has(role)) {
    line.elapsedMs = elapsedMs ?? null;
    line.starts = starts ?? null;
    if (role === 'done') line.criteria = criteria ?? null;
  }

  return `${JSON.stringify(line)}\n`;
}

/**
 * The events in a log, oldest first, plus how many lines could not be read.
 *
 * A JSONL file gets truncated writes, hand edits and merge conflict markers.
 * None of that is a reason to throw: the caller wants the events it can have,
 * and the count is reported so a silently half-read log is impossible.
 *
 * @returns {{events: object[], skipped: number}}
 */
export function parseLog(text) {
  const events = [];
  let skipped = 0;

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.id && parsed.event) events.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}

/**
 * The events for `id` since it was last closed — its current cycle.
 *
 * A ticket that is reopened and worked again is a second cycle, and measuring
 * across both would report a fortnight for two days of work.
 */
export function currentCycle(events, id) {
  const mine = (events ?? []).filter((e) => e.id === id);
  let from = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (CLOSING.has(mine[i].event)) {
      from = i + 1;
      break;
    }
  }
  return mine.slice(from);
}

/** How many times `id` entered the start rung in the current cycle. */
export function startsSince(events, id) {
  return currentCycle(events, id).filter((e) => e.event === 'start').length;
}

/**
 * Milliseconds from the first start of the current cycle to `at`, or null.
 *
 * Null when no start was ever recorded — a ticket closed by `sync` that was
 * begun on somebody else's machine has no local start, and inventing one from
 * the branch or the ticket's own history would be a guess dressed as a
 * measurement.
 */
export function elapsedSince(events, id, at = new Date()) {
  const first = currentCycle(events, id).find((e) => e.event === 'start');
  if (!first?.at) return null;

  const began = Date.parse(first.at);
  if (Number.isNaN(began)) return null;
  return Math.max(0, at.getTime() - began);
}

/**
 * The whole close event for `id`, measured against the log so far.
 *
 * One function so the three fields cannot be assembled differently by two
 * callers — which is the shape every drift in this repo has taken.
 */
export function closeEvent({ events, role, id, state, at = new Date(), provider, criteria }) {
  return renderEvent({
    role,
    id,
    state,
    at,
    provider,
    elapsedMs: elapsedSince(events, id, at),
    starts: startsSince(events, id),
    criteria,
  });
}

/** Is instrumentation on for this project? On unless it was turned off. */
export const metricsEnabled = (config) => config?.metrics !== false;

/** Where the log lives, relative to the project root. */
export const metricsFileOf = (config) => config?.metricsFile ?? DEFAULT_METRICS_FILE;

/**
 * Validate a `--criteria` value, naming the alternatives.
 *
 * Rejecting an unknown value rather than storing it keeps the field worth
 * counting: two spellings of "first pass" in one log is a field nobody can
 * aggregate, and nothing downstream would ever notice.
 */
export function parseCriteria(value) {
  if (value === undefined || value === null || value === '') return { ok: true, criteria: null };
  if (CRITERIA.includes(value)) return { ok: true, criteria: value };
  return { ok: false, error: `--criteria takes ${CRITERIA.join(' or ')}, not "${value}"` };
}
