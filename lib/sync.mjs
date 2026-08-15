/**
 * The reconciler's decision logic, with no I/O in it.
 *
 * Everything here is a pure function so the rules that make `yt sync` safe to
 * run from a hook or a cron — forward-only movement, off-ladder tickets left
 * alone, idempotence — are testable without a YouTrack instance or a GitHub
 * token. The I/O lives in scripts/cmd/sync.mjs.
 */

/** `30d`, `48h`, `2w` -> minutes. Throws on anything else. */
export function parseSince(since) {
  const m = /^(\d+)([dhw]?)$/.exec(String(since ?? '').trim());
  if (!m) throw new Error('--since takes a value like 7d, 48h or 2w');
  const n = Number(m[1]);
  const per = { d: 1440, h: 60, w: 10080, '': 1440 };
  return n * per[m[2]];
}

/** An ISO-8601 cutoff `minutes` before `now`. */
export function cutoffFrom(minutes, now = Date.now()) {
  return `${new Date(now - minutes * 60_000).toISOString().slice(0, 19)}Z`;
}

/**
 * Every issue ID in `text`, deduplicated and in order.
 *
 * Takes either an `IdSyntax` (see lib/issueid.mjs) or, for convenience and to
 * keep this module dependency-free, a bare project key meaning YouTrack. The
 * string form also escapes the key before it reaches a RegExp — it is user
 * input, and interpolating it raw was a latent bug.
 *
 * Coverage is bounded by the convention, not by this: a PR that names no issue
 * anywhere is invisible to the reconciler. That is the finding, not a bug.
 *
 * @param {string} text
 * @param {import('./issueid.mjs').IdSyntax | string} syntax
 */
export function extractIssueIds(text, syntax) {
  if (!text || !syntax) return [];

  const re =
    typeof syntax === 'string'
      ? new RegExp(`\\b${syntax.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\b`, 'g')
      : syntax.regex;
  if (!re) return [];

  // A shared global RegExp carries `lastIndex` between calls, so a fresh one is
  // built per call rather than reusing the object the syntax handed over.
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...new Set(String(text).match(scan) ?? [])];
}

/**
 * Owner/repo from a git remote URL, in either SSH or HTTPS form.
 * Returns null when the URL is not a recognisable forge remote.
 */
export function slugFromRemoteUrl(url) {
  if (!url) return null;
  const cleaned = String(url)
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  const m =
    /^[\w.-]+@[^:]+:(.+)$/.exec(cleaned) ?? /^[a-z]+:\/\/[^/]+\/(.+)$/i.exec(cleaned);
  const path = (m?.[1] ?? '').replace(/^\/+/, '');
  return path.includes('/') ? path : null;
}

/**
 * Fold PR observations into the strongest evidence per issue.
 *
 * `observations` are `{ id, rank, state, url }`. A merged PR (higher rank) beats
 * an open one for the same issue, so a ticket with both lands on `done`.
 *
 * @returns {Map<string, {rank: number, state: string, url: string}>}
 */
export function strongestEvidence(observations) {
  const out = new Map();
  for (const o of observations) {
    if (!o?.id) continue;
    const prev = out.get(o.id);
    if (!prev || o.rank > prev.rank) out.set(o.id, { rank: o.rank, state: o.state, url: o.url });
  }
  return out;
}

/**
 * The state an adapter reports when it could not read one.
 *
 * Lives here, in the pure module, because `decide` below is the thing that
 * consumes it and this file imports nothing. Every adapter imports this
 * constant rather than spelling the string, so the two halves of the contract
 * cannot drift — a provider returning `'Unknown'` would otherwise be silently
 * treated as an off-ladder state and skipped forever.
 */
export const UNKNOWN = 'unknown';

/**
 * What to do with one issue.
 *
 * The reconciler only ever moves a ticket FORWARD. A ticket whose state is not
 * on the ladder at all was parked in Blocked or Won't Fix on purpose and is
 * left alone; a ticket already at or past the target is a no-op, which is what
 * makes running this twice safe.
 *
 * @returns {{action: 'unreadable'|'off-ladder'|'ahead'|'move', why: string}}
 */
export function decide({ current, currentRank, targetRank, url }) {
  if (current === UNKNOWN) return { action: 'unreadable', why: 'could not read — skipped' };
  if (currentRank < 0) return { action: 'off-ladder', why: 'off-ladder, left alone' };
  if (currentRank >= targetRank) return { action: 'ahead', why: 'already there or ahead' };
  return { action: 'move', why: url };
}

/** Fill `{url}` and `{state}` in the configured comment template. */
export function renderComment(template, { url, state }) {
  return String(template ?? '')
    .split('{url}')
    .join(url ?? '')
    .split('{state}')
    .join(state ?? '');
}

/**
 * Sort issue IDs by their numeric part, so ABC-9 precedes ABC-10.
 *
 * Deliberately provider-agnostic: matching the trailing digits rather than
 * `-(\d+)` handles `ABC-12` and `#12` alike, with identical results for every
 * YouTrack ID. The narrower pattern silently scored `#12` as 0, which sorted
 * every GitHub issue into one indistinguishable clump.
 */
export function byIssueNumber(a, b) {
  const n = (s) => Number(/(\d+)$/.exec(s)?.[1] ?? 0);
  return n(a) - n(b) || a.localeCompare(b);
}
