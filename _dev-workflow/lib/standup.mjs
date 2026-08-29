/**
 * "What is going on across this project?", decided and rendered here, with no IO.
 *
 * `lib/status.mjs` answers where **one** checkout stands. This answers the
 * question a standup asks — what moved, what is stuck, and what is waiting on
 * *you* — across every configured repo at once. Same split, same reasons: the
 * clock is a parameter, so every line below is asserted without a repository, a
 * network or a tracker, and the same inputs print the same bytes.
 *
 * It reports and never writes, like `status` and unlike `sync`. That is not a
 * missing feature: a command people run first thing in the morning has to be
 * safe to run without thinking about what it might do to the board.
 *
 * ## What it can and cannot see
 *
 * Three sources, and the third is the one that took a bug to add. Local
 * checkouts and pull requests answer what is being *worked on*; `provider
 * .listOpen` answers what is on the *board*. Without that third read this
 * command could see only work somebody had already branched for, and it said
 * so in a comment here — while still printing "nothing is waiting on you",
 * which is a claim about the whole board made by something that never asked
 * the board (#35).
 *
 * The bound that remains is real and is stated in the report rather than here:
 * if the tracker cannot be reached, the open section says that instead of
 * printing nothing, because an empty section and an unread tracker look
 * identical and only one of them means the board is clear.
 *
 * What it still cannot see is anything a tracker calls closed. That is not a
 * gap — a standup is about what is open.
 */
import { rankOf } from './config.mjs';
import { PR_UNKNOWN } from './status.mjs';

/** Priority given to work that is waiting on somebody else. Never "next". */
export const WAITING = 9;

/**
 * How many open issues the report prints before it summarises the rest.
 *
 * A cap rather than the whole list, and the reason is context rather than
 * screen space: the SessionStart hook feeds this report into every session of
 * every project that installs it, so each line is paid for by every turn
 * afterwards. Eight rows plus a count is enough to know whether the board is
 * three issues or ninety; the command to read the rest is printed beside it.
 */
export const OPEN_SHOWN = 8;

/** Milliseconds in a day, named because the arithmetic below reads badly otherwise. */
const DAY = 86_400_000;

/**
 * How long ago `iso` was, in whole days — negative-safe, null for no timestamp.
 *
 * A branch with no commits at all has no age, and reporting that as "0 days"
 * would put it top of a staleness list it does not belong on.
 */
export function ageDays(iso, now = new Date()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / DAY));
}

/**
 * A duration a person reads at a glance: `today`, `3d`, `2w`, `4mo`.
 *
 * Deliberately coarse. The exact hour a commit landed is in `git log`; what a
 * standup needs to know is whether something has been sitting for a week.
 */
export function humanAge(iso, now = new Date()) {
  const days = ageDays(iso, now);
  if (days === null) return '-';
  if (days === 0) return 'today';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/**
 * The pull requests merged inside the window, newest first.
 *
 * `cutoff` is an ISO-8601 string from `cutoffFrom` in lib/sync.mjs — the same
 * one the reconciler uses, so "since" means the same thing in both commands.
 */
export function mergedSince(prs, { cutoff }) {
  return (prs ?? [])
    .filter((pr) => String(pr?.state ?? '').toUpperCase() === 'MERGED')
    .filter((pr) => (pr.mergedAt ?? '') >= cutoff)
    .sort((a, b) => String(b.mergedAt ?? '').localeCompare(String(a.mergedAt ?? '')) || a.number - b.number);
}

/**
 * The rows that count as in flight: everything that is not the base branch.
 *
 * The main checkout sits on the base branch and is a worktree like any other,
 * so `status --all` lists it — correctly, it is asking what is checked out.
 * A standup is asking what is being *worked on*, and the base branch never is.
 *
 * A branch with no ticket stays: a stray worktree nobody remembers is exactly
 * the sort of thing a standup should surface, and hiding it would make it
 * permanently invisible.
 */
export function inFlight(rows, { base }) {
  return (rows ?? []).filter((row) => row.branch !== base);
}

/**
 * What one piece of in-flight work needs, as a priority and a sentence.
 *
 * The priorities are a fixed table rather than a judgement, and the table is the
 * whole design: the cheapest thing that unblocks the board comes first (a
 * merged PR whose ticket nobody reconciled), then work that is genuinely in
 * your hands, and anything waiting on another human sorts last and is never
 * offered as "next". Nothing here invents advice — each line names a command
 * the project is already configured for.
 *
 * @param {{issue: ?object, pr: ?object, dirty: number, commits: ?number, config: object}} row
 * @returns {{priority: number, advice: string}}
 */
export function classify({ issue, pr, dirty = 0, commits = null, config }) {
  const state = pr && pr !== PR_UNKNOWN ? String(pr.state ?? '').toUpperCase() : null;
  const id = issue?.id ?? '';

  if (state === 'MERGED') {
    // Merged, but is the ticket there yet? Only the ladder can say, and a
    // ticket whose state cannot be read is not evidence of anything.
    const done = config?.states?.done;
    const here = issue?.state ? rankOf(config, issue.state) : -1;
    if (issue?.state && here >= 0 && here < rankOf(config, done)) {
      return { priority: 0, advice: `PR #${pr.number} is merged but the ticket is not — dev.mjs sync --apply` };
    }
    return { priority: WAITING, advice: `merged and reconciled — nothing to do` };
  }

  if (state === 'CLOSED') {
    return {
      priority: 1,
      advice: `PR #${pr.number} was closed unmerged — reopen it, or dev.mjs abandon ${id} "<why>"`,
    };
  }

  if (state === 'OPEN') return { priority: WAITING, advice: `PR #${pr.number} is waiting on review` };

  if (dirty > 0) {
    return {
      priority: 2,
      advice: `${dirty} uncommitted change${dirty === 1 ? '' : 's'} — commit them, then: dev.mjs land`,
    };
  }

  if (commits > 0) return { priority: 3, advice: `${commits} commit${commits === 1 ? '' : 's'} ready — dev.mjs land` };

  // A branch behind its ticket, or a branch with nothing on it: both mean the
  // work was set up and never done, and `resume` is the command that prints
  // what is actually there.
  const start = config?.states?.start;
  if (issue?.state && start && rankOf(config, issue.state) >= 0 && rankOf(config, issue.state) < rankOf(config, start)) {
    return { priority: 4, advice: `the ticket is behind the branch — dev.mjs resume ${id}` };
  }
  return { priority: 5, advice: `nothing committed yet — dev.mjs resume ${id}` };
}

/**
 * The one thing to pick up, or null when nothing is waiting on you.
 *
 * Null is a real answer and the reason this is not just "the first row": a
 * board where everything sits in review is a board with nothing for you to do,
 * and inventing a task there would make the whole report untrustworthy.
 */
export function pickNext(rows, config) {
  const ranked = rows
    .map((row) => ({ row, ...classify({ ...row, config }) }))
    .filter((r) => r.priority < WAITING)
    .sort((a, b) => a.priority - b.priority || byRowId(a.row, b.row));

  return ranked[0] ?? null;
}

/**
 * Open rows, newest first: the highest issue number is the most recently filed.
 *
 * The opposite of `byRowId`, and deliberately so. In flight is a worklist and
 * reads in the order the work was taken on; the board is a backlog, where what
 * was filed last week matters more than what was filed last year.
 */
function byOpenId(a, b) {
  const n = (row) => Number(String(row.id ?? '').replace(/\D+/g, '')) || 0;
  return n(b) - n(a) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/** Rows with no issue sort last; otherwise by issue number, so #9 precedes #10. */
function byRowId(a, b) {
  const n = (row) => Number(String(row.issue?.id ?? '').replace(/\D+/g, '')) || Infinity;
  return n(a) - n(b) || String(a.branch ?? '').localeCompare(String(b.branch ?? ''));
}

/**
 * The whole report, as lines.
 *
 * Sections in the order a standup is actually given: what landed, what is in
 * flight, what has stopped moving, and the single thing to do next. An empty
 * section prints a sentence saying it is empty rather than vanishing — a report
 * that silently omits "stale" reads identically whether nothing is stale or the
 * check never ran.
 *
 * `open` is what the tracker answered, as `{rows, truncated, error}`. A null
 * `error` with an empty `rows` means an empty board; a non-null one means
 * nobody knows, and the two must never render the same.
 *
 * @param {{
 *   rows: Array<object>, merged: Array<object>, config: object,
 *   since: string, cutoff: string, staleAfter: number,
 *   open?: ?{rows?: Array<object>, truncated?: boolean, error?: ?string},
 *   now?: Date, prUnknown?: boolean,
 * }} facts
 */
export function describeStandup(facts) {
  const {
    rows = [],
    merged = [],
    config,
    since,
    cutoff,
    staleAfter,
    open = null,
    now = new Date(),
    prUnknown = false,
  } = facts;

  const L = [];
  L.push(`standup   ${now.toISOString().slice(0, 10)}   since ${cutoff.slice(0, 10)} (${since})`);

  L.push('', `merged since ${cutoff.slice(0, 10)}`);
  if (!merged.length) {
    L.push('  (nothing merged in the window — widen it with --since 7d)');
  } else {
    for (const pr of merged) {
      const ticket = pr.issue ? `${pr.issue.id} ${pr.issue.state ?? 'unknown state'}` : 'no ticket';
      L.push(`  #${pr.number}  ${truncate(pr.title, 52)}   ${ticket}`);
      if (pr.issue?.state && rankOf(config, pr.issue.state) >= 0 &&
          rankOf(config, pr.issue.state) < rankOf(config, config.states.done)) {
        L.push('        ^ merged, but the ticket has not been reconciled — dev.mjs sync --apply');
      }
    }
  }

  L.push('', 'in flight');
  if (!rows.length) {
    L.push('  (no ticket branches — nothing is checked out)');
  } else {
    const header = `  ${'ISSUE'.padEnd(8)} ${'STATE'.padEnd(13)} ${'PR'.padEnd(11)} ${'TREE'.padEnd(8)} ${'AGE'.padEnd(6)} BRANCH`;
    L.push(header);
    for (const row of [...rows].sort(byRowId)) {
      L.push(
        `  ${(row.issue?.id ?? '-').padEnd(8)} ${(row.issue?.state ?? '-').padEnd(13)} ` +
          `${prCell(row.pr).padEnd(11)} ${treeCell(row).padEnd(8)} ` +
          `${humanAge(row.lastCommit, now).padEnd(6)} ${row.branch ?? '(detached)'}`,
      );
    }
  }

  const stale = rows.filter((row) => {
    const days = ageDays(row.lastCommit, now);
    return days !== null && days >= staleAfter;
  });
  L.push('', `stale — no commit for ${staleAfter}d`);
  if (!stale.length) {
    L.push('  (nothing has been sitting that long)');
  } else {
    for (const row of stale.sort(byRowId)) {
      const { advice } = classify({ ...row, config });
      L.push(`  ${(row.issue?.id ?? '-').padEnd(8)} ${humanAge(row.lastCommit, now).padEnd(6)} ${advice}`);
    }
  }

  // Everything the tracker calls open that nothing above has already accounted
  // for. Filtering here rather than in the caller keeps the whole decision
  // assertable without a tracker, and an issue listed twice in one report is
  // noise that makes the section look wrong rather than new.
  const accounted = new Set(
    [...rows.map((r) => r.issue?.id), ...merged.map((m) => m.issue?.id)].filter(Boolean),
  );
  const unstarted = (open?.rows ?? []).filter((row) => !accounted.has(row.id));

  // Not read and read-and-failed are two facts and one consequence: nobody
  // knows what is on the board, so nothing below may speak for it.
  const boardUnknown = !open || Boolean(open.error);

  L.push('', 'open in the tracker');
  if (open?.error) {
    // The whole point of the section: an unreachable tracker must not render
    // as a clear board.
    L.push(`  (could not read the tracker: ${truncate(open.error, 60)})`);
  } else if (!open) {
    L.push('  (not read)');
  } else if (!unstarted.length) {
    L.push(
      open.rows?.length
        ? '  (nothing open that is not already in flight above)'
        : '  (no open issues)',
    );
  } else {
    for (const row of [...unstarted].sort(byOpenId).slice(0, OPEN_SHOWN)) {
      L.push(`  ${row.id.padEnd(8)} ${String(row.state ?? '-').padEnd(13)} ${truncate(row.title, 52)}`);
    }
    const hidden = unstarted.length - Math.min(unstarted.length, OPEN_SHOWN);
    if (hidden > 0 || open.truncated) {
      const count = open.truncated ? `${hidden}+` : String(hidden);
      // No command of ours lists open issues — `status --all` lists worktrees —
      // so this points at the tracker rather than inventing one.
      L.push(`  … and ${count} more open — see the tracker`);
    }
  }

  L.push('', 'next');
  const next = pickNext(rows, config);
  if (next) {
    L.push(`  ${next.row.issue?.id ?? next.row.branch} — ${next.advice}`);
  } else if (boardUnknown) {
    // Scoped deliberately, and this sentence is the actual defect in #35. The
    // old one asserted the state of the whole board from what happened to be
    // checked out locally. With the board unread the only honest claim is
    // about the part that was read.
    L.push('  nothing in flight is waiting on you — the board is unread, so nothing here speaks for what is unstarted');
  } else if (unstarted.length) {
    // `next` still ranks in-flight work only and never picks from the tracker:
    // starting something is a decision, and the section above is where it is
    // made. This points at it rather than choosing from it.
    L.push(
      `  nothing in flight is waiting on you — ${unstarted.length} open above, unstarted: dev.mjs start <ISSUE-ID>`,
    );
  } else {
    L.push(
      rows.length
        ? '  nothing is waiting on you — everything in flight is with someone else'
        : '  nothing in flight and nothing open — the board is clear',
    );
  }

  if (prUnknown) {
    L.push('', 'PR state unavailable: the GitHub CLI is missing or not authenticated (gh auth login).');
  }
  return L;
}

const truncate = (text, max) => {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

const prCell = (pr) => {
  if (pr === PR_UNKNOWN) return '-';
  if (!pr) return 'none';
  return `#${pr.number} ${String(pr.state ?? '').toLowerCase().slice(0, 6)}`;
};

const treeCell = (row) => {
  if (row.dirty > 0) return `${row.dirty} dirty`;
  return row.commits > 0 ? `${row.commits} ahead` : 'clean';
};
