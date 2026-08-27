/**
 * Where the work stands.
 *
 *   dev.mjs status          this checkout: branch, ticket, state, PR, tree
 *   dev.mjs status --all    every worktree and every ticket in flight
 *   dev.mjs status --repo P restrict to one configured repo
 *
 * This reports and never writes. `sync` is the one that moves tickets, and it
 * stays separate on purpose: a command people run to orient themselves must be
 * safe to run without thinking, including on someone else's branch.
 *
 * It also degrades rather than failing. Without the GitHub CLI the PR columns
 * read `-` and everything else still prints, because "I cannot reach GitHub" is
 * not a reason to refuse to say which branch you are on. Exit code is 0 unless
 * the project is not configured at all — the precedent `version` sets.
 */
import { resolve } from 'node:path';

import { PR_UNKNOWN, describeBoard, describeCheckout } from '../../lib/status.mjs';
import { issueIdFromBranch } from '../../lib/branch.mjs';
import { sh, shJson, has } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, resolveRepo, UserError } from './common.mjs';

function parseArgs(args) {
  const opts = { all: false, repo: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') opts.all = true;
    else if (a === '--repo') opts.repo = args[++i] ?? '';
    else throw new UserError(`unknown argument '${a}' — usage: dev.mjs status [--all] [--repo PATH]`);
  }
  return opts;
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const { config, root, provider } = await context();
  const vcs = makeVcs({ run: sh });

  // A command run inside a worktree resolves its root to that worktree, since
  // the config file is tracked and travels with it. Worktrees and branches
  // belong to the main checkout, so normalise first — the same trap start.mjs
  // documents at its top.
  const main = await vcs.mainCheckout(root);

  const rows = await collect({ config, main, vcs, opts });
  const withIssues = await withStates(provider, rows);

  if (opts.all) {
    process.stdout.write(`${describeBoard(withIssues, { root: main }).join('\n')}\n`);
  } else {
    const here = withIssues.find((r) => r.here) ?? withIssues[0];
    if (!here) throw new UserError('no checkout found — is this a git repository?');
    const { lines } = describeCheckout({
      branch: here.branch,
      isWorktree: here.path !== main,
      issue: here.issue,
      pr: here.pr,
      dirty: here.dirty,
      config,
    });
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (withIssues.some((r) => r.pr === PR_UNKNOWN)) {
    process.stdout.write(
      '\nPR state unavailable: the GitHub CLI is missing or not authenticated (gh auth login).\n',
    );
  }
  return 0;
}

/** One row per checkout to report on, before any tracker call. */
async function collect({ config, main, vcs, opts }) {
  const cwd = process.cwd();

  // Local mode asks about one directory and needs no repo walk at all; the PR
  // lookup still runs against it, so a ticket branch in any repo reports its PR.
  if (!opts.all) {
    const entry = { path: cwd, branch: await vcs.currentBranch(cwd) };
    return [await rowFor({ config, vcs, entry, cwd, prs: await pullRequests(cwd) })];
  }

  // `--all` on a multi-repo project means every repo, not just the one the
  // command happened to be run in. `--repo` narrows it, routed through the same
  // `resolveRepo` that `start` and `land` use so the argument means one thing.
  const dirs = opts.repo
    ? [resolveRepo(config, main, opts.repo).dir]
    : repoDirs(config, main);

  return (await scanRepos({ config, vcs, dirs, cwd })).rows;
}

/**
 * Every worktree in `dirs` as a row, plus every pull request seen along the way.
 *
 * Exported because `standup` asks the same question of the same repos and must
 * not grow a second scanner: two of these would disagree about what "in flight"
 * means the first time either is touched. It returns the raw PR list as well as
 * the rows, since a merged PR's branch is usually gone — the row it would have
 * been attached to no longer exists, and that is exactly what a standup reports.
 *
 * @returns {Promise<{rows: object[], prs: object[], prUnknown: boolean}>}
 */
export async function scanRepos({ config, vcs, dirs, cwd }) {
  const rows = [];
  const prs = [];
  let prUnknown = false;

  for (const dir of dirs) {
    // Each repo has its own worktrees and its own PRs; a second repo's branches
    // are not this one's, and matching them by name across repos would invent
    // relationships that do not exist.
    const listed = await listPullRequests(dir);
    if (listed === PR_UNKNOWN) prUnknown = true;
    else prs.push(...listed.map((pr) => ({ ...pr, dir })));

    const byBranch = listed === PR_UNKNOWN ? PR_UNKNOWN : prsByBranch(listed);
    for (const entry of await vcs.listWorktreeEntries(dir)) {
      rows.push(await rowFor({ config, vcs, entry, cwd, prs: byBranch }));
    }
  }

  return { rows, prs, prUnknown };
}

/** The configured repos as absolute directories, defaulting to the project root. */
export function repoDirs(config, main) {
  const paths = (config.repos ?? []).map((r) => r.path).filter(Boolean);
  if (!paths.length) return [main];
  return paths.map((p) => (p === '.' ? main : resolve(main, p)));
}

async function rowFor({ config, vcs, entry, cwd, prs }) {
  const clean = await vcs.isClean(entry.path);
  return {
    path: entry.path,
    branch: entry.branch,
    here: samePath(entry.path, cwd),
    dirty: clean.ok && !clean.clean ? clean.dirty.length : 0,
    issueId: entry.branch ? issueIdFromBranch(config, entry.branch) : null,
    pr: prs === PR_UNKNOWN ? PR_UNKNOWN : (prs.get(entry.branch) ?? null),
  };
}

/** cwd is inside `path`, or is it. Compared as strings: both come from git or node. */
const samePath = (path, cwd) => cwd === path || cwd.startsWith(`${path}/`);

/**
 * PRs by head branch, or PR_UNKNOWN when gh cannot answer.
 *
 * One call for the whole repo rather than one per branch: `--all` on a project
 * with six worktrees would otherwise be six round trips for information one
 * request already carries.
 */
async function pullRequests(dir) {
  const listed = await listPullRequests(dir);
  return listed === PR_UNKNOWN ? PR_UNKNOWN : prsByBranch(listed);
}

/**
 * Every recent pull request in `dir`, or PR_UNKNOWN when gh cannot answer.
 *
 * `title` and `mergedAt` are asked for on behalf of `standup`, which reports
 * what merged and when. They cost nothing here — one request either way — and
 * asking twice with different field lists is how the two commands would end up
 * disagreeing about which PRs exist.
 */
export async function listPullRequests(dir) {
  if (!(await has('gh'))) return PR_UNKNOWN;

  const r = await shJson(
    'gh',
    [
      'pr', 'list',
      '--state', 'all',
      '--limit', '100',
      '--json', 'number,headRefName,state,url,title,mergedAt,updatedAt',
    ],
    { cwd: dir },
  );
  if (!r.ok) return PR_UNKNOWN;
  return Array.isArray(r.data) ? r.data : [];
}

/** The newest PR per head branch. A reused branch otherwise reports a stale one. */
export function prsByBranch(prs) {
  const byBranch = new Map();
  // `gh` lists most recent first, so the first PR seen for a branch wins.
  for (const pr of prs) if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr);
  return byBranch;
}

/**
 * Attach tracker state, in one batched read.
 *
 * `getStates` is the batched shape every adapter already implements, which
 * matters on a CLI-backed backend where each read is a process spawn.
 */
async function withStates(provider, rows) {
  const ids = [...new Set(rows.map((r) => r.issueId).filter(Boolean))];
  const states = ids.length ? await provider.getStates(ids) : new Map();

  return rows.map((row) => ({
    ...row,
    issue: row.issueId ? { id: row.issueId, state: states.get(row.issueId) ?? null } : null,
  }));
}
