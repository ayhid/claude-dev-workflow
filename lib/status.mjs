/**
 * "Where does this work stand?", decided here and rendered here, with no IO.
 *
 * This is a *report*, and that is what separates it from `sync`. The reconciler
 * answers "what should I move?" and says nothing when the answer is nothing;
 * this answers "what is going on?", which has to stay useful when everything is
 * fine. The two must never quietly become one command: a reporter that writes,
 * or a reconciler that guesses, is worse than either.
 *
 * Pure, so every shape below is asserted without a repository, a network or a
 * tracker — the same split `lib/sync.mjs` has against `scripts/cmd/sync.mjs`.
 */

import { rankOf } from './config.mjs';

/** What a PR column shows when the GitHub CLI could not be consulted at all. */
export const PR_UNKNOWN = 'unknown';

/**
 * The one-checkout view: a handful of labelled lines.
 *
 * `pr` is `null` for "looked, found none" and `PR_UNKNOWN` for "could not
 * look" — a distinction worth keeping, because "no PR yet" invites you to open
 * one and "I could not check" does not.
 *
 * @param {{
 *   branch: string|null,
 *   isWorktree?: boolean,
 *   issue?: {id: string, state?: string|null, title?: string|null}|null,
 *   pr?: {number: number, state: string, url?: string}|null|'unknown',
 *   dirty?: number,
 *   config: object,
 * }} facts
 * @returns {{lines: string[], next: string|null}}
 */
export function describeCheckout(facts) {
  const { branch, isWorktree = false, issue = null, pr = null, dirty = 0, config } = facts;
  const L = [];
  const row = (label, value) => L.push(`${label.padEnd(10)}${value}`);

  row('branch', branch ? `${branch}${isWorktree ? '   (worktree)' : ''}` : 'detached HEAD');

  if (!issue) {
    // Not a failure. Plenty of legitimate work has no ticket, and the escape
    // hatch exists for exactly that; saying so beats guessing an ID out of a
    // branch name that never carried one.
    row('issue', `none — this branch carries no issue ID`);
  } else {
    row('issue', `${issue.id}  ${issue.state ?? 'unknown state'}`);
    if (issue.title) row('title', issue.title);
  }

  row('pr', renderPr(pr));
  row('tree', dirty === 0 ? 'clean' : `${dirty} uncommitted change${dirty === 1 ? '' : 's'}`);

  const next = nextStep({ issue, pr, dirty, config });
  if (next) row('next', next);

  return { lines: L, next };
}

function renderPr(pr) {
  if (pr === PR_UNKNOWN) return '-  (could not ask the GitHub CLI)';
  if (!pr) return 'none yet';
  const state = String(pr.state ?? '').toLowerCase();
  return `#${pr.number} ${state}${pr.url ? `  ${pr.url}` : ''}`;
}

/**
 * The single most useful next command, or null when there is nothing to suggest.
 *
 * Deliberately conservative. It suggests only what the configuration already
 * decided — `land` follows `delivery.mode`, it does not choose it — and it
 * suggests nothing at all when the honest answer is "waiting on a human".
 */
export function nextStep({ issue, pr, dirty, config }) {
  if (!issue) return null;

  if (pr && pr !== PR_UNKNOWN) {
    const state = String(pr.state ?? '').toUpperCase();
    if (state === 'MERGED') return 'merged — the reconciler moves the ticket, or run: dev.mjs sync';
    if (state === 'CLOSED') return 'the PR was closed unmerged; reopen it or start again';
    return 'waiting on review';
  }

  if (dirty > 0) return 'commit the work, then: dev.mjs land';

  const current = issue.state ?? null;
  const start = config?.states?.start ?? null;
  if (current && start && rankOf(config, current) < rankOf(config, start)) {
    return `the ticket is behind the branch — dev.mjs update ${issue.id} state start`;
  }

  return 'dev.mjs land';
}

/**
 * The board view: one row per worktree, newest issue last.
 *
 * Sorted by issue number so the same inputs print the same bytes (contract rule
 * 4). Rows with no issue sort last: they are real, and hiding them would make a
 * stray worktree invisible exactly when you are trying to find out what is
 * lying around.
 *
 * @param {Array<{path: string, branch: string|null, issue: object|null, pr: object|null|'unknown', dirty: number}>} rows
 */
export function describeBoard(rows, { root = null } = {}) {
  const header = `${'ISSUE'.padEnd(10)} ${'STATE'.padEnd(14)} ${'PR'.padEnd(12)} ${'TREE'.padEnd(8)} BRANCH`;
  const out = [header, '-'.repeat(Math.max(header.length, 60))];

  for (const row of [...rows].sort(byIssue)) {
    const id = row.issue?.id ?? '-';
    const state = row.issue?.state ?? '-';
    const pr =
      row.pr === PR_UNKNOWN ? '-' : row.pr ? `#${row.pr.number} ${shortState(row.pr.state)}` : 'none';
    const tree = row.dirty > 0 ? `${row.dirty} dirty` : 'clean';
    const where = row.branch ?? relative(row.path, root);
    out.push(`${id.padEnd(10)} ${state.padEnd(14)} ${pr.padEnd(12)} ${tree.padEnd(8)} ${where}`);
  }

  if (rows.length === 0) out.push('(no worktrees — nothing is checked out for a ticket)');
  return out;
}

const shortState = (s) => String(s ?? '').toLowerCase().slice(0, 6);

const relative = (path, root) =>
  root && path.startsWith(root) ? path.slice(root.length + 1) || '.' : path;

/** Numeric where possible, so #9 sorts before #10; ticketless rows last. */
function byIssue(a, b) {
  const ida = a.issue?.id ?? null;
  const idb = b.issue?.id ?? null;
  if (!ida && !idb) return String(a.branch ?? '').localeCompare(String(b.branch ?? ''));
  if (!ida) return 1;
  if (!idb) return -1;

  const na = Number(String(ida).replace(/\D+/g, ''));
  const nb = Number(String(idb).replace(/\D+/g, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(ida).localeCompare(String(idb));
}
