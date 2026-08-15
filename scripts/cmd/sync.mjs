/**
 * Reconcile YouTrack issue states against what GitHub actually shows.
 *
 *   dev.mjs sync                # dry run — report drift, change nothing
 *   dev.mjs sync --apply        # apply the transitions
 *   dev.mjs sync --since 14d    # widen the window (default 30d)
 *   dev.mjs sync --repo frontend
 *   dev.mjs sync --deep         # also read commit subjects (1 extra call per PR)
 *
 * This is a reconciler, not an event handler. It asks "given the PRs that exist
 * right now, where should each ticket be?" and advances anything that has fallen
 * behind. A webhook that fires while the runner is down loses the event and the
 * ticket is wrong forever; a reconciler that misses a week costs only latency.
 *
 * Evidence, weakest to strongest:
 *   open PR referencing the issue    -> states.review
 *   merged PR referencing the issue  -> states.done
 *
 * The decision rules live in lib/sync.mjs and are unit-tested; this file is the
 * I/O around them. It is the one command that drives external tools (gh, git)
 * rather than plain HTTP.
 */
import { ladderOf, rankOf } from '../../lib/config.mjs';
import { has, sh, shJson } from '../../lib/sh.mjs';
import {
  byIssueNumber,
  cutoffFrom,
  decide,
  extractIssueIds,
  parseSince,
  renderComment,
  slugFromRemoteUrl,
  strongestEvidence,
  UNKNOWN,
} from '../../lib/sync.mjs';
import { context, UserError } from './common.mjs';

function parseArgs(argv) {
  const opts = { apply: false, deep: false, since: '30d', repo: '', limit: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--deep') opts.deep = true;
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else throw new UserError(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) throw new UserError('--limit takes a number');
  return opts;
}

async function requireGh() {
  if (!(await has('gh'))) {
    throw new UserError('the GitHub CLI (gh) is required — see https://cli.github.com');
  }
  if (!(await sh('gh', ['auth', 'status'])).ok) {
    throw new UserError('gh is not authenticated — run: gh auth login');
  }
}

/** repos[].github wins; otherwise parse the upstream, then origin, remote. */
async function slugFor(config, repoPath, dir) {
  const explicit = config.repos?.find((r) => r.path === repoPath)?.github;
  if (explicit) return explicit;

  // A missing remote is normal, not an error: probe quietly and move on. The
  // stderr is captured rather than streamed, so `fatal: not a git repository`
  // never reaches the terminal looking like a real failure.
  for (const remote of ['upstream', 'origin']) {
    const res = await sh('git', ['-C', dir, 'remote', 'get-url', remote]);
    if (res.ok) {
      const slug = slugFromRemoteUrl(res.stdout);
      if (slug) return slug;
    }
  }
  return null;
}

/** PRs in one state, newer than the cutoff, as issue-ID observations. */
async function observePrs({ slug, prState, cutoff, project, rank, state, deep, limit }) {
  const res = await shJson('gh', [
    'pr', 'list',
    '-R', slug,
    '--state', prState,
    '--limit', String(limit),
    '--json', 'number,headRefName,title,url,mergedAt,createdAt',
  ]);
  if (!res.ok) {
    process.stderr.write(`  could not list ${prState} PRs for ${slug}: ${res.error}\n`);
    return [];
  }

  const prs = Array.isArray(res.data) ? res.data : [];
  const observations = [];
  for (const pr of prs) {
    if (((pr.mergedAt ?? pr.createdAt) ?? '') < cutoff) continue;

    const ids = extractIssueIds(`${pr.headRefName} ${pr.title}`, project);

    if (ids.length === 0 && deep) {
      // The branch and title said nothing, but the commit convention puts the
      // ID in the subject — one extra call to look there.
      const commits = await sh('gh', [
        'pr', 'view', String(pr.number),
        '-R', slug,
        '--json', 'commits',
        '-q', '.commits[].messageHeadline',
      ]);
      if (commits.ok) ids.push(...extractIssueIds(commits.stdout, project));
    }

    for (const id of new Set(ids)) observations.push({ id, rank, state, url: pr.url });
  }
  return observations;
}

export async function run(argv) {
  const opts = parseArgs(argv);
  await requireGh();

  const { config, root, provider } = await context({ requireProject: true });
  const ladder = ladderOf(config);
  const rankReview = rankOf(config, config.states.review);
  const rankDone = rankOf(config, config.states.done);

  if (rankReview < 0) {
    throw new UserError(
      `states.review ('${config.states.review}') is not on states.ladder (${ladder.join(', ')})`,
    );
  }
  if (rankDone < 0) {
    throw new UserError(
      `states.done ('${config.states.done}') is not on states.ladder (${ladder.join(', ')})`,
    );
  }

  const cutoff = cutoffFrom(parseSince(opts.since));
  const repoPaths = config.repos?.length ? config.repos.map((r) => r.path) : ['.'];

  const observations = [];
  let scanned = 0;

  for (const repoPath of repoPaths) {
    if (opts.repo && opts.repo !== repoPath) continue;
    const dir = repoPath === '.' ? root : `${root}/${repoPath}`;

    const slug = await slugFor(config, repoPath, dir);
    if (!slug) {
      process.stderr.write(`skipping '${repoPath}' — no GitHub remote found\n`);
      continue;
    }
    process.stderr.write(`scanning ${repoPath} (${slug})\n`);
    scanned++;

    for (const [prState, rank, state] of [
      ['merged', rankDone, config.states.done],
      ['open', rankReview, config.states.review],
    ]) {
      observations.push(
        ...(await observePrs({
          slug,
          prState,
          cutoff,
          project: config.project,
          rank,
          state,
          deep: opts.deep,
          limit: opts.limit,
        })),
      );
    }
  }

  if (scanned === 0) {
    throw new UserError(
      'no repositories scanned — check .dev-workflow.json repos[] and their git remotes',
    );
  }

  const evidence = strongestEvidence(observations);
  if (evidence.size === 0) {
    process.stdout.write(
      `\nNo ${config.project} issues referenced by PRs since ${cutoff}. Nothing to reconcile.\n`,
    );
    return 0;
  }

  // --- compare against YouTrack ---------------------------------------------
  const row = (a, b, c, d) => `${a.padEnd(12)} ${b.padEnd(16)} ${c.padEnd(16)} ${d}`;
  process.stdout.write(`\n${row('ISSUE', 'CURRENT', 'SHOULD BE', 'WHY')}\n${'-'.repeat(72)}\n`);

  // One batched read rather than one call per issue. On an HTTP backend that
  // is a nicety; on a CLI-backed one each read is a process spawn *plus* a
  // round trip, so the loop must not do it per issue.
  const ids = [...evidence.keys()].sort(byIssueNumber);
  const states = await provider.getStates(ids);

  const planned = [];
  for (const id of ids) {
    const { rank: targetRank, state: targetState, url } = evidence.get(id);
    const current = states.get(id) ?? UNKNOWN;
    const { action, why } = decide({
      current,
      currentRank: rankOf(config, current),
      targetRank,
      url,
    });

    if (action === 'move') {
      process.stdout.write(`${row(id, current, targetState, why)}\n`);
      planned.push({ id, targetState, url });
    } else {
      const shown = action === 'unreadable' ? targetState : '-';
      process.stdout.write(`${row(id, action === 'unreadable' ? '?' : current, shown, why)}\n`);
    }
  }

  if (planned.length === 0) {
    process.stdout.write('\nEverything is in sync.\n');
    return 0;
  }

  if (!opts.apply) {
    process.stdout.write(`\n${planned.length} issue(s) would move. Re-run with --apply to do it.\n`);
    return 0;
  }

  // --- apply -----------------------------------------------------------------
  let failed = false;
  process.stdout.write('\n');

  for (const { id, targetState, url } of planned) {
    const comment = renderComment(config.sync?.comment, { url, state: targetState });
    const result = await provider.setState(id, targetState, comment);

    if (!result.ok) {
      // Never swallow this: the first --apply failure printed only "update
      // failed", while the parser error underneath named the problem exactly.
      process.stdout.write(`  ${id.padEnd(12)} !! ${result.error}\n`);
      failed = true;
      continue;
    }

    // setState already reads back, but state the comparison explicitly:
    // this command's whole value is being trustworthy without someone reading
    // its output line by line.
    if (result.state === targetState) {
      process.stdout.write(`  ${id.padEnd(12)} -> ${result.state}\n`);
    } else {
      process.stdout.write(`  ${id.padEnd(12)} !! asked for ${targetState}, reads ${result.state}\n`);
      failed = true;
    }
  }

  if (failed) throw new UserError('some transitions did not apply — see above');

  process.stdout.write(`\nDone. ${planned.length} issue(s) reconciled.\n`);
  return 0;
}
