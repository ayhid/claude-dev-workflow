/**
 * What is going on across the whole project, in the order a standup is given.
 *
 *   dev.mjs standup [--since 1d] [--stale 7d] [--repo PATH]
 *
 * Five questions, one command: what merged, what is in flight, what has stopped
 * moving, what is open on the board, and the single thing waiting on you.
 * `status --all` answers the second; the rest is what a session — or a person
 * on a Monday — actually needs before deciding anything.
 *
 * It reports and never writes, and that is a contract rather than an omission:
 * this is the first thing run in the morning, and a command that reconciles the
 * board as a side effect of being asked about it would be unsafe to run without
 * thinking. Where it sees drift it prints the command that fixes it and stops.
 *
 * The scan itself is `status`'s, imported rather than reimplemented — two
 * scanners would disagree about what "in flight" means the first time either
 * was touched. What this adds per branch is two cheap git reads: how far ahead
 * of the base it is, and when it was last committed to, which is what makes
 * "stale" a measurement rather than an impression.
 *
 * Without the GitHub CLI it still runs: the PR columns read `-`, the merged
 * section is empty, and it says so. "I cannot reach GitHub" is not a reason to
 * refuse to say what is checked out.
 */
import { issueIdFromBranch } from '../../lib/branch.mjs';
import { sh } from '../../lib/sh.mjs';
import { describeStandup, inFlight, mergedSince } from '../../lib/standup.mjs';
import { PR_UNKNOWN } from '../../lib/status.mjs';
import { cutoffFrom, extractIssueIds, parseSince } from '../../lib/sync.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, emitUpdateBanner, resolveRepo, takeValue, UserError } from './common.mjs';
import { repoDirs, scanRepos } from './status.mjs';

const USAGE = 'usage: dev.mjs standup [--since 1d] [--stale 7d] [--repo PATH]';

export function parseArgs(argv) {
  const opts = { since: '1d', stale: '7d', repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') opts.since = takeValue(argv, ++i, a);
    else if (a === '--stale') opts.stale = takeValue(argv, ++i, a);
    else if (a === '--repo') opts.repo = takeValue(argv, ++i, a);
    else throw new UserError(`unknown argument '${a}'\n\n${USAGE}`);
  }
  return opts;
}

/**
 * The board itself, as facts the renderer can print either way.
 *
 * Every other ID this command has came from a branch or a pull request, so an
 * issue nobody has started contributes none and was invisible to the entire
 * report — the defect in #35. This is the one read that does not depend on what
 * happens to be checked out.
 *
 * A failure is carried rather than thrown, the same trade the `gh`-missing path
 * already makes: "I cannot reach the tracker" is a sentence in the report, not
 * a reason to refuse to say what is checked out. The catch is there for the
 * SessionStart hook — a greeting that stack-traces because a tracker was down
 * is worse than one that says the tracker was down.
 */
async function readBoard(provider) {
  try {
    const r = await provider.listOpen();
    return r.ok
      ? { rows: r.data ?? [], truncated: Boolean(r.truncated), error: null }
      : { rows: [], truncated: false, error: r.error };
  } catch (err) {
    return { rows: [], truncated: false, error: err?.message ?? String(err) };
  }
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const { config, root, provider } = await context();
  const vcs = makeVcs({ run: sh });

  // Run from inside a worktree and the config walk resolves the root to that
  // worktree, which carries a tracked copy of the config. Worktrees belong to
  // the main checkout — the trap `start` documents at its top.
  const main = await vcs.mainCheckout(root);
  const base = config.branch?.base ?? 'main';

  // Both windows go through the reconciler's own parser, so `7d` means the same
  // thing in every command that takes one.
  const cutoff = cutoffFrom(parseSince(opts.since));
  const staleAfter = Math.max(1, Math.round(parseSince(opts.stale) / 1440));

  const dirs = opts.repo ? [resolveRepo(config, main, opts.repo).dir] : repoDirs(config, main);
  const scanned = await scanRepos({ config, vcs, dirs, cwd: process.cwd() });

  const rows = [];
  for (const row of inFlight(scanned.rows, { base })) {
    // Two reads per branch, and only for branches that are in flight. Doing
    // this in `status` instead would put a git call per worktree behind a
    // command whose whole point is to answer instantly.
    const dir = row.path;
    const ahead = row.branch ? await vcs.commitsAhead(dir, { base, branch: row.branch }) : null;
    rows.push({
      ...row,
      commits: ahead?.ok ? ahead.count : null,
      lastCommit: row.branch ? await vcs.lastCommitAt(dir, row.branch) : null,
    });
  }

  const merged = mergedSince(scanned.prs, { cutoff }).map((pr) => ({
    ...pr,
    // The branch first, then the title: a ref cannot hold a `#`, so the two
    // carry the ID in different syntaxes and only one rule reads each.
    issueId:
      issueIdFromBranch(config, pr.headRefName) ?? extractIssueIds(pr.title, provider.syntax)[0] ?? null,
  }));

  // One batched read for every ticket on the board, in flight or just merged.
  // Per issue here would be a process spawn plus a round trip each on a
  // CLI-backed backend, for a command meant to be run every morning.
  const ids = [...new Set([...rows.map((r) => r.issueId), ...merged.map((m) => m.issueId)].filter(Boolean))];

  // The two tracker reads are independent, so they go out together. Sequential
  // they cost about half a second more, and this runs inside the SessionStart
  // hook's 3s ceiling — past which the greeting is dropped entirely. On a
  // CLI-backed backend the preflight is memoised, so the second call does not
  // repeat it.
  const [states, open] = await Promise.all([
    ids.length ? provider.getStates(ids) : Promise.resolve(new Map()),
    readBoard(provider),
  ]);
  const issueOf = (id) => (id ? { id, state: states.get(id) ?? null } : null);

  const lines = describeStandup({
    rows: rows.map((row) => ({ ...row, issue: issueOf(row.issueId) })),
    merged: merged.map((pr) => ({ ...pr, issue: issueOf(pr.issueId) })),
    open,
    config,
    since: opts.since,
    cutoff,
    staleAfter,
    prUnknown: scanned.prUnknown || rows.some((r) => r.pr === PR_UNKNOWN),
  });

  process.stdout.write(`${lines.join('\n')}\n`);

  // Last, and on stderr: this reports, and a notice about the tool is not part
  // of the report.
  await emitUpdateBanner(root);
  return 0;
}
