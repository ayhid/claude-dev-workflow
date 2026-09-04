/**
 * Reconcile YouTrack issue states against what GitHub actually shows.
 *
 *   dev.mjs sync                # dry run — report drift, change nothing
 *   dev.mjs sync --apply        # apply the transitions
 *   dev.mjs sync --since 14d    # widen the window (default 30d)
 *   dev.mjs sync --repo frontend
 *   dev.mjs sync --deep         # also read an unmatched PR's commit subjects
 *                               # (1 extra API call per PR; the base-branch
 *                               # commit scan below is free and always on)
 *
 * This is a reconciler, not an event handler. It asks "given what has been
 * pushed right now, where should each ticket be?" and advances anything that has
 * fallen behind. A webhook that fires while the runner is down loses the event and the
 * ticket is wrong forever; a reconciler that misses a week costs only latency.
 *
 * Evidence, weakest to strongest:
 *   open PR referencing the issue      -> states.review
 *   merged PR referencing the issue    -> states.done
 *   commit on the base branch          -> states.done
 *
 * That third line is not a nicety. A project on `delivery.mode: direct` never
 * opens a pull request, so PR evidence about it does not exist and never will:
 * the reconciler saw nothing, found nothing to do, and said "everything is in
 * sync" while every ticket sat in the state it started in. A commit reachable
 * from the base branch has landed, which is the same fact a merged PR carries.
 * It also covers what bypasses `land` on a `pr` project — a hand-pushed fix, a
 * hotfix, work done outside a session.
 *
 * It also repairs the case that looks like nothing: an issue in the right state
 * whose *representation* of that state is stale. GitHub closes an issue by
 * itself when a PR says `Closes #12`, so the ticket reads as done while still
 * carrying the `in review` label — correctly `ahead`, and stranded forever.
 * `provider.checkRepresentation` is what makes that visible here; the rung ->
 * label mapping stays in the adapter, where the config for it lives.
 *
 * Every pass is bounded by the same window: this reconciles issues referenced by
 * a PR or a landed commit since `--since`, so a strand older than that needs one
 * wider run.
 *
 * The decision rules live in lib/sync.mjs and are unit-tested; this file is the
 * I/O around them. It is the one command that drives external tools (gh, git)
 * rather than plain HTTP.
 */
import { issueIdFromBranch } from '../../lib/branch.mjs';
import { deliveryBase, deliveryFor, ladderOf, rankOf } from '../../lib/config.mjs';
import { has, sh, shJson } from '../../lib/sh.mjs';
import {
  byIssueNumber,
  commitObservations,
  cutoffFrom,
  decide,
  extractIssueIds,
  LOG_SEP,
  parseSince,
  renderComment,
  slugFromRemoteUrl,
  strongestEvidence,
  UNKNOWN,
} from '../../lib/sync.mjs';
import { context, takeValue, UserError } from './common.mjs';

export function parseArgs(argv) {
  const opts = { apply: false, deep: false, since: '30d', repo: '', limit: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--deep') opts.deep = true;
    else if (a === '--since') opts.since = takeValue(argv, ++i, a);
    else if (a === '--repo') opts.repo = takeValue(argv, ++i, a);
    else if (a === '--limit') opts.limit = Number(takeValue(argv, ++i, a));
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
async function observePrs({ config, slug, prState, cutoff, syntax, rank, state, deep, limit }) {
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

    // The title is prose, so it carries an ID in prose form (`#42`). A branch
    // name never does — refs cannot sensibly hold a `#` — so it is parsed by the
    // rule that renders it. Scanning a branch with the prose syntax is why a
    // GitHub project only ever reconciled through PR titles.
    const ids = extractIssueIds(pr.title, syntax);
    const fromBranch = issueIdFromBranch(config, pr.headRefName);
    if (fromBranch) ids.unshift(fromBranch);

    if (ids.length === 0 && deep) {
      // The branch and title said nothing, but the commit convention puts the
      // ID in the subject — one extra call to look there.
      const commits = await sh('gh', [
        'pr', 'view', String(pr.number),
        '-R', slug,
        '--json', 'commits',
        '-q', '.commits[].messageHeadline',
      ]);
      if (commits.ok) ids.push(...extractIssueIds(commits.stdout, syntax));
    }

    for (const id of new Set(ids)) observations.push({ id, rank, state, url: pr.url });
  }
  return observations;
}

/**
 * The ref that answers "has this landed", or null when nothing resolves.
 *
 * A remote-tracking ref first, and the same `upstream` then `origin` order
 * `slugFor` uses: the local base branch can be stale, or hold commits nobody
 * has pushed, and neither of those has landed. The local branch is the last
 * resort rather than the first, and is right for a repo with no remote at all.
 */
async function baseRefFor(dir, base) {
  for (const ref of [`upstream/${base}`, `origin/${base}`, base]) {
    const res = await sh('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (res.ok) return ref;
  }
  return null;
}

/** Commits on the base branch, newer than the cutoff, as issue-ID observations. */
async function observeCommits({ dir, ref, slug, cutoff, syntax, rank, state }) {
  // `--no-merges` is load-bearing, not tidiness. GitHub's own merge commit is
  // titled `Merge pull request #38 from …`, and on GitHub that reads as a
  // perfectly well-formed issue ID — for a *pull request* number. Every merge
  // would credit whatever issue happens to share that number.
  const res = await sh('git', [
    '-C', dir,
    'log', ref,
    '--no-merges',
    `--since=${cutoff}`,
    `--format=%H${LOG_SEP}%s`,
  ]);
  if (!res.ok) {
    process.stderr.write(`  could not read commits on ${ref}: ${res.stderr || `exit ${res.code}`}\n`);
    return [];
  }
  return commitObservations(res.stdout, {
    syntax,
    rank,
    state,
    urlFor: (sha) => `https://github.com/${slug}/commit/${sha}`,
  });
}

export async function run(argv) {
  const opts = parseArgs(argv);
  await requireGh();

  const { config, root, provider } = await context();
  // The ID shape comes from the provider, so a GitHub project scans PR titles
  // for `#123` rather than for a project key that does not exist there.
  const syntax = provider.syntax;
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
    // Resolved before the passes below so the line says what was actually read.
    // A repo whose base branch does not exist here is not an error — the PR
    // passes still work — but it is exactly the case that would otherwise look
    // like a clean run, so it is said out loud.
    const base = deliveryBase(config, deliveryFor(config, repoPath));
    const baseRef = await baseRefFor(dir, base);
    process.stderr.write(
      baseRef
        ? `scanning ${repoPath} (${slug}) — PRs, and commits on ${baseRef}\n`
        : `scanning ${repoPath} (${slug}) — PRs only, no branch '${base}' here\n`,
    );
    scanned++;

    for (const [prState, rank, state] of [
      ['merged', rankDone, config.states.done],
      ['open', rankReview, config.states.review],
    ]) {
      observations.push(
        ...(await observePrs({
          config,
          slug,
          prState,
          cutoff,
          syntax,
          rank,
          state,
          deep: opts.deep,
          limit: opts.limit,
        })),
      );
    }

    // Last, deliberately. `strongestEvidence` keeps the first observation at a
    // given rank, and a merged PR carries a URL a reader can do more with than
    // a bare commit — so a ticket with both keeps the PR.
    if (baseRef) {
      observations.push(
        ...(await observeCommits({
          dir,
          ref: baseRef,
          slug,
          cutoff,
          syntax,
          rank: rankDone,
          state: config.states.done,
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
      // The ID shape, not the project key: `config.project` is a YouTrack key
      // that a GitHub config has no equivalent of, so this line read "No null
      // issues…" for every GitHub project. The syntax sample says the same
      // thing — which IDs were scanned for — and every backend has one.
      `\nNo issues matching ${provider.syntax.sample} referenced by a PR or a landed commit since ${cutoff}. Nothing to reconcile.\n`,
    );
    return 0;
  }

  // --- compare against the tracker ------------------------------------------
  const row = (a, b, c, d) => `${a.padEnd(12)} ${b.padEnd(16)} ${c.padEnd(16)} ${d}`;
  process.stdout.write(`\n${row('ISSUE', 'CURRENT', 'SHOULD BE', 'WHY')}\n${'-'.repeat(72)}\n`);

  // One batched read rather than one call per issue. On an HTTP backend that
  // is a nicety; on a CLI-backed one each read is a process spawn *plus* a
  // round trip, so the loop must not do it per issue.
  const ids = [...evidence.keys()].sort(byIssueNumber);
  const states = await provider.getStates(ids);
  // The second question of the same read: which of these say something other
  // than the state they are in? A backend whose state is its own
  // representation answers null for every id and this costs nothing.
  const stale = await provider.checkRepresentation(ids);

  const planned = [];
  const repairs = [];
  for (const id of ids) {
    const { rank: targetRank, state: targetState, url } = evidence.get(id);
    const current = states.get(id) ?? UNKNOWN;
    const { action, why } = decide({
      current,
      currentRank: rankOf(config, current),
      targetRank,
      url,
      stale: stale.get(id) ?? null,
    });

    if (action === 'move') {
      process.stdout.write(`${row(id, current, targetState, why)}\n`);
      planned.push({ id, targetState, url });
    } else if (action === 'repair') {
      // The state is right, so SHOULD BE is not another state — it is the
      // representation catching up with the one the issue is already in.
      process.stdout.write(`${row(id, current, 'relabel', why)}\n`);
      repairs.push({ id, why });
    } else {
      const shown = action === 'unreadable' ? targetState : '-';
      process.stdout.write(`${row(id, action === 'unreadable' ? '?' : current, shown, why)}\n`);
    }
  }

  if (planned.length === 0 && repairs.length === 0) {
    process.stdout.write('\nEverything is in sync.\n');
    return 0;
  }

  const summary = [
    planned.length ? `${planned.length} issue(s) would move` : null,
    repairs.length ? `${repairs.length} would be relabelled` : null,
  ].filter(Boolean);

  if (!opts.apply) {
    process.stdout.write(`\n${summary.join(', ')}. Re-run with --apply to do it.\n`);
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

  // Repairs run after the moves, and never through setState: nothing here
  // transitions, and recording one would put a second close in the metrics log
  // for work that was closed once.
  let relabelled = 0;
  for (const { id } of repairs) {
    const result = await provider.repairRepresentation(id);
    if (!result.ok) {
      process.stdout.write(`  ${id.padEnd(12)} !! ${result.error}\n`);
      failed = true;
      continue;
    }
    if (result.repaired) relabelled += 1;
    // `repaired: false` means the drift was gone by the time we wrote — someone
    // else fixed it, or it was never there. Say which happened rather than
    // reporting a repair that did not occur.
    process.stdout.write(
      result.repaired
        ? `  ${id.padEnd(12)} ~> ${result.state}  (labels repaired)\n`
        : `  ${id.padEnd(12)} -- nothing to repair (${result.why})\n`,
    );
  }

  if (failed) throw new UserError('some transitions did not apply — see above');

  const done = [
    planned.length ? `${planned.length} issue(s) reconciled` : null,
    // What was attempted is not what happened: a strand someone else fixed
    // between the read and the write reports `repaired: false` above, and
    // counting it here would make the summary contradict the lines over it.
    relabelled ? `${relabelled} relabelled` : null,
  ].filter(Boolean);
  // Only repairs were planned and every one of them found the drift already
  // gone. The per-issue lines above each said so; an empty summary here would
  // print `Done. .` and claim nothing at all.
  process.stdout.write(`\nDone. ${done.length ? done.join(', ') : 'nothing to repair'}.\n`);
  return 0;
}
