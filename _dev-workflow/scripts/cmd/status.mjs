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

  const rows = [];
  for (const dir of dirs) {
    // Each repo has its own worktrees and its own PRs; a second repo's branches
    // are not this one's, and matching them by name across repos would invent
    // relationships that do not exist.
    const prs = await pullRequests(dir);
    for (const entry of await vcs.listWorktreeEntries(dir)) {
      rows.push(await rowFor({ config, vcs, entry, cwd, prs }));
    }
  }
  return rows;
}

/** The configured repos as absolute directories, defaulting to the project root. */
function repoDirs(config, main) {
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
 * Open and merged PRs by head branch, or PR_UNKNOWN when gh cannot answer.
 *
 * One call for the whole repo rather than one per branch: `--all` on a project
 * with six worktrees would otherwise be six round trips for information one
 * request already carries.
 */
async function pullRequests(dir) {
  if (!(await has('gh'))) return PR_UNKNOWN;

  const r = await shJson(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'number,headRefName,state,url'],
    { cwd: dir },
  );
  if (!r.ok) return PR_UNKNOWN;

  const byBranch = new Map();
  for (const pr of Array.isArray(r.data) ? r.data : []) {
    // Newest wins: `gh` lists most recent first, so only take the first PR seen
    // for a branch. A reused branch name otherwise reports a stale closed PR.
    if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr);
  }
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
