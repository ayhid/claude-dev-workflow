/**
 * The board of a split ticket's work units, and the two things done to them.
 *
 *   dev.mjs build <PARENT> [--start] [--land [--apply]] [--repo PATH]
 *
 * With no flag it reads and prints: every child of the parent, its tracker
 * state, its local checkout and pull request, and the wave it belongs to —
 * classified by `lib/units.mjs` from tracker state first and dependencies
 * second. That is the whole of what `/dev-build` needs to decide what to do
 * next, in one command rather than a turn per unit.
 *
 * `--start` mounts a worktree for every **ready** unit — untouched, and every
 * dependency done — through the same `startIssue` that `start` runs, serially
 * in this process: two `git worktree add` racing on one `.git` is the kind of
 * failure nothing reports. One provider is built for all of them, so the `gh`
 * preflight runs once. It forks each unit from the freshest base it can see —
 * `origin/<base>` after a fetch when it exists — because under `pr` delivery
 * nothing moves the local base between waves, and a second wave forked from
 * it would never see the first wave's merged code. It ends with one line per
 * ready unit, `dispatch: <ID>\t<path>`, which is what the skill fans out on.
 *
 * `--land` dry-runs every unit whose work is committed and whose tree is
 * clean; `--land --apply` lands them one after another through `land` and
 * reconciles the tracker **once** at the end rather than once per unit. A
 * rebase conflict under `direct` delivery stops the loop with the branch left
 * as it was found (`lib/vcs.mjs` rule 2); nothing here resolves one.
 *
 * Children fork from the configured base, never from each other or from a
 * parent branch. That is what keeps every other command — `sync`, `status`,
 * `standup`, the commit hook — working on a unit exactly as on a ticket, and
 * it is why a later wave has to wait for the earlier one to land.
 */
import { findIssueCheckouts } from '../../lib/branch.mjs';
import { deliveryFor } from '../../lib/config.mjs';
import { canonicalId, idSyntaxFor } from '../../lib/issueid.mjs';
import { sh } from '../../lib/sh.mjs';
import { PR_UNKNOWN } from '../../lib/status.mjs';
import { classifyUnits, computeWaves, parseDependsOn, parseUnitRepo } from '../../lib/units.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, must, resolveRepo, UserError } from './common.mjs';
import { stateGap } from './resume.mjs';
import { startIssue } from './start.mjs';
import { listPullRequests, prsByBranch } from './status.mjs';

const USAGE = 'usage: dev.mjs build <PARENT-ID> [--start] [--land [--apply]] [--repo PATH]';

function parseArgs(args) {
  const opts = { start: false, land: false, apply: false };
  const rest = [];
  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex++) {
    const argument = args[argumentIndex];
    if (argument === '--start') opts.start = true;
    else if (argument === '--land') opts.land = true;
    else if (argument === '--apply') opts.apply = true;
    else if (argument === '--repo') opts.repo = args[++argumentIndex];
    else if (argument.startsWith('-')) throw new UserError(`unknown flag ${argument}\n\n${USAGE}`);
    else rest.push(argument);
  }
  if (opts.start && opts.land) throw new UserError('--start and --land are two different steps — pass one');
  if (opts.apply && !opts.land) throw new UserError('--apply goes with --land');
  return { opts, rest };
}

/** `#43` padded to the width the board aligns on. */
const padColumn = (value, width) => String(value ?? '').padEnd(width);

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  if (!rest[0]) throw new UserError(USAGE);

  const { config, root, provider } = await context();
  const parent = canonicalId(config, rest[0]);
  const syntax = idSyntaxFor(config);
  const vcs = makeVcs({ run: sh });

  const issue = must(await provider.getIssue(parent));
  const children = must(await provider.children(parent));

  const outputLines = [];
  if (!children.length) {
    outputLines.push(`parent:   ${parent} — ${issue.title}`);
    outputLines.push(`children: none — this ticket was not split, so it is built as one unit: dev.mjs start ${parent}`);
    process.stdout.write(`${outputLines.join('\n')}\n`);
    return 0;
  }

  const units = children.map((child) => ({
    id: child.id,
    title: child.title,
    dependsOn: parseDependsOn(child.body, syntax),
    repo: parseUnitRepo(child.body),
  }));

  const order = computeWaves(units);
  if (!order.ok) throw new UserError(`${parent}'s units cannot be ordered: ${order.error}`);

  // One batched read for the parent, every unit and every external dependency.
  const wanted = [...new Set([parent, ...units.map((unit) => unit.id), ...order.external.flatMap((dependency) => dependency.dependsOn)])];
  const states = await provider.getStates(wanted);
  const buckets = classifyUnits(units, states, config);

  // Which repo each unit lives in. A single-repo project has one answer; a
  // multi-repo project wrote it into the unit's body at split time, and a unit
  // that carries none falls back to --repo, then to the refusal `resolveRepo`
  // already words.
  const repoOf = (unit) => resolveRepo(config, root, unit.repo ?? opts.repo);
  const repoDirs = new Map();
  const repoFor = async (unit) => {
    const repository = repoOf(unit);
    if (!repoDirs.has(repository.path)) {
      const dir = await vcs.mainCheckout(repository.dir);
      const [worktrees, branches, prs] = await Promise.all([
        vcs.listWorktreeEntries(dir),
        vcs.listBranches(dir),
        listPullRequests(dir),
      ]);
      repoDirs.set(repository.path, {
        ...repository,
        dir,
        worktrees,
        branches,
        prs: prs === PR_UNKNOWN ? PR_UNKNOWN : prsByBranch(prs),
      });
    }
    return repoDirs.get(repository.path);
  };

  const rows = [];
  for (const unit of units) {
    const repo = await repoFor(unit);
    const checkout = findIssueCheckouts(config, { worktrees: repo.worktrees, branches: repo.branches }, unit.id)[0] ?? null;
    const pr = checkout && repo.prs !== PR_UNKNOWN ? (repo.prs.get(checkout.branch) ?? null) : null;
    rows.push({ ...unit, ...buckets.get(unit.id), checkout, pr, repo });
  }

  outputLines.push(`parent:   ${parent} — ${issue.title}   state: ${states.get(parent)}`);
  for (const [waveIndex, wave] of order.waves.entries()) {
    outputLines.push(`wave ${waveIndex + 1}`);
    for (const id of wave) {
      const row = rows.find((candidate) => candidate.id === id);
      const bits = [];
      if (row.pr) bits.push(`PR #${row.pr.number} ${String(row.pr.state ?? '').toLowerCase()}`);
      if (row.checkout?.path) bits.push(row.checkout.path + (row.bucket === 'done' ? '   (stale — remove when convenient)' : ''));
      else if (row.checkout) bits.push(`branch ${row.checkout.branch} (not mounted)`);
      if (row.bucket === 'blocked') bits.push(`waits on ${row.waitsOn.join(', ')}`);
      if (row.bucket === 'unknown') bits.push(row.why);
      outputLines.push(`  ${padColumn(row.id, 8)} ${padColumn(row.bucket, 12)} ${padColumn(row.title, 40)} ${bits.join('   ')}`.replace(/\s+$/, ''));
    }
  }
  for (const dependency of order.external) {
    outputLines.push(`note:     ${dependency.id} also depends on ${dependency.dependsOn.join(', ')}, outside this split`);
  }

  const ready = rows.filter((row) => row.bucket === 'ready');
  const inProgress = rows.filter((row) => row.bucket === 'in progress' && row.checkout?.path);
  const allDone = rows.every((row) => row.bucket === 'done');

  if (!opts.start && !opts.land) {
    if (allDone) outputLines.push(`next:     every unit is done — close the parent: /dev-done ${parent}`);
    else if (ready.length) outputLines.push(`next:     build ${parent} --start   — ${ready.length} unit(s) ready`);
    else if (inProgress.length) outputLines.push(`next:     build ${parent} --land    — ${inProgress.length} unit(s) in progress`);
    else if (rows.some((row) => row.bucket === 'review')) outputLines.push('next:     waiting on pull requests to merge — dev.mjs sync, then run this again');
    else outputLines.push('next:     nothing is ready — see the units above');
    process.stdout.write(`${outputLines.join('\n')}\n`);
    return 0;
  }

  if (opts.start) return start({ config, provider, vcs, parent, states, ready, outputLines });
  return land({ config, parent, inProgress, rows, apply: opts.apply, vcs, outputLines });
}

/** `--start`: mount every ready unit, serially, from the freshest base. */
async function start({ config, provider, vcs, parent, states, ready, outputLines }) {
  const mode = config.branch?.mode ?? 'worktree';
  const base = config.branch?.base ?? 'main';

  if (!ready.length) {
    outputLines.push('start:    nothing is ready');
    process.stdout.write(`${outputLines.join('\n')}\n`);
    return 0;
  }
  if (mode !== 'worktree' && ready.filter((row) => !row.checkout?.path).length > 1) {
    throw new UserError(
      `branch.mode is "${mode}", which holds one checkout at a time, and ${ready.length} units are ready — ` +
        'set branch.mode to "worktree" to build them side by side, or start one by hand: ' +
        `dev.mjs start ${ready[0].id}`,
    );
  }

  // The parent is in progress once any of its units is. Forward only, the
  // rule `resume` applies, and never through a guess about an unreadable state.
  const gap = stateGap(config, states.get(parent));
  if (gap.move) {
    const moved = await provider.setState(parent, 'start');
    outputLines.push(moved.ok ? `parent:   moved to ${moved.state}` : `parent:   NOT MOVED — ${moved.error}`);
  }

  // Fork from what has actually landed. `fetch` failing is not fatal — offline,
  // the local base is the freshest base there is — but it is said.
  const forkFrom = new Map();
  const dispatch = [];
  for (const row of ready) {
    const repo = row.repo;
    if (!forkFrom.has(repo.path)) {
      const remote = deliveryFor(config, repo.path).remote ?? 'origin';
      const fresh = await vcs.freshestBase({ dir: repo.dir, remote, base });
      forkFrom.set(repo.path, fresh.ref);
      if (fresh.why) outputLines.push(`note:     forking from local ${base} — ${fresh.why}`);
    }

    if (row.checkout?.path) {
      outputLines.push(`mounted:  ${row.id} already at ${row.checkout.path}`);
      dispatch.push([row.id, row.checkout.path]);
      continue;
    }

    const started = await startIssue({
      config,
      provider,
      vcs,
      configured: { path: repo.path, dir: repo.dir },
      id: row.id,
      base: forkFrom.get(repo.path),
    });
    for (const line of started.lines) if (/^(branch|mode|forked|created|state|warning):/.test(line)) outputLines.push(`  ${line}`);
    if (!started.moved) outputLines.push(`  ${row.id} was mounted but not moved — retry: dev.mjs update ${row.id} state start`);
    if (started.dir) dispatch.push([row.id, started.dir]);
  }

  outputLines.push('');
  for (const [id, path] of dispatch) outputLines.push(`dispatch: ${id}\t${path}`);
  process.stdout.write(`${outputLines.join('\n')}\n`);
  return 0;
}

/** `--land`: hand each finished unit to `land`, then reconcile once. */
async function land({ config, parent, inProgress, rows, apply, vcs, outputLines }) {
  const landable = [];
  for (const row of inProgress) {
    // The same question `land` asks of a single unit, asked of each one in the
    // wave — so it has to be the same question: tracked changes only.
    const clean = await vcs.isClean(row.checkout.path, { untracked: false });
    if (!clean.ok) {
      outputLines.push(`skipped:  ${row.id} tree UNKNOWN in ${row.checkout.path}: ${clean.error}`);
      continue;
    }
    if (!clean.clean) {
      outputLines.push(`skipped:  ${row.id} has ${clean.dirty.length} uncommitted change(s) in ${row.checkout.path}`);
      continue;
    }
    landable.push(row);
  }
  for (const row of rows.filter((candidate) => candidate.bucket === 'in progress' && !candidate.checkout?.path)) {
    outputLines.push(`skipped:  ${row.id} is in progress but checked out nowhere — dev.mjs resume ${row.id}`);
  }
  if (!landable.length) {
    outputLines.push('land:     nothing to land');
    process.stdout.write(`${outputLines.join('\n')}\n`);
    return 0;
  }

  outputLines.push(`land:     ${landable.map((row) => row.id).join(', ')}${apply ? '' : '   (dry run — pass --apply)'}`);
  process.stdout.write(`${outputLines.join('\n')}\n\n`);

  const { run: landRun } = await import('./land.mjs');
  for (const row of landable) {
    process.stdout.write(`--- ${row.id}\n`);
    const args = [row.id, '--repo', row.repo.path, ...(apply ? ['--apply'] : [])];
    // The reconcile is deferred to the end: one `sync --apply` for the wave,
    // not one per unit. A refusal stops the loop where it is — the units
    // before it have landed, the one that failed says why, the rest wait.
    const code = await landRun(args, { reconcile: false });
    if (code !== 0) {
      process.stderr.write(`dev build: ${row.id} did not land — stopping here; the units after it are untouched\n`);
      return code;
    }
  }

  if (!apply) return 0;

  const delivery = deliveryFor(config, landable[0].repo.path);
  if (delivery.mode === 'pr') {
    process.stdout.write('\n--- reconcile\n');
    const { run: syncRun } = await import('./sync.mjs');
    let code;
    try {
      code = await syncRun(['--apply']);
    } catch (err) {
      code = 1;
      process.stderr.write(`dev build: ${err.message}\n`);
    }
    if (code !== 0) {
      process.stderr.write(
        `dev build: the pull requests exist, but the tickets were not reconciled — move them by hand: ` +
          `dev.mjs update <ID> state review "<PR url>"\n`,
      );
      return code;
    }
    process.stdout.write(`\nnext:     when the pull requests merge — dev.mjs sync, then build ${parent} again\n`);
  }
  return 0;
}
