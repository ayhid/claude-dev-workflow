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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--start') opts.start = true;
    else if (a === '--land') opts.land = true;
    else if (a === '--apply') opts.apply = true;
    else if (a === '--repo') opts.repo = args[++i];
    else if (a.startsWith('-')) throw new UserError(`unknown flag ${a}\n\n${USAGE}`);
    else rest.push(a);
  }
  if (opts.start && opts.land) throw new UserError('--start and --land are two different steps — pass one');
  if (opts.apply && !opts.land) throw new UserError('--apply goes with --land');
  return { opts, rest };
}

/** `#43` padded to the width the board aligns on. */
const col = (s, w) => String(s ?? '').padEnd(w);

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  if (!rest[0]) throw new UserError(USAGE);

  const { config, root, provider } = await context();
  const parent = canonicalId(config, rest[0]);
  const syntax = idSyntaxFor(config);
  const vcs = makeVcs({ run: sh });

  const issue = must(await provider.getIssue(parent));
  const children = must(await provider.children(parent));

  const L = [];
  if (!children.length) {
    L.push(`parent:   ${parent} — ${issue.title}`);
    L.push(`children: none — this ticket was not split, so it is built as one unit: dev.mjs start ${parent}`);
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  const units = children.map((c) => ({
    id: c.id,
    title: c.title,
    dependsOn: parseDependsOn(c.body, syntax),
    repo: parseUnitRepo(c.body),
  }));

  const order = computeWaves(units);
  if (!order.ok) throw new UserError(`${parent}'s units cannot be ordered: ${order.error}`);

  // One batched read for the parent, every unit and every external dependency.
  const wanted = [...new Set([parent, ...units.map((u) => u.id), ...order.external.flatMap((e) => e.dependsOn)])];
  const states = await provider.getStates(wanted);
  const buckets = classifyUnits(units, states, config);

  // Which repo each unit lives in. A single-repo project has one answer; a
  // multi-repo project wrote it into the unit's body at split time, and a unit
  // that carries none falls back to --repo, then to the refusal `resolveRepo`
  // already words.
  const repoOf = (u) => resolveRepo(config, root, u.repo ?? opts.repo);
  const repoDirs = new Map();
  const repoFor = async (u) => {
    const r = repoOf(u);
    if (!repoDirs.has(r.path)) {
      const dir = await vcs.mainCheckout(r.dir);
      const [worktrees, branches, prs] = await Promise.all([
        vcs.listWorktreeEntries(dir),
        vcs.listBranches(dir),
        listPullRequests(dir),
      ]);
      repoDirs.set(r.path, {
        ...r,
        dir,
        worktrees,
        branches,
        prs: prs === PR_UNKNOWN ? PR_UNKNOWN : prsByBranch(prs),
      });
    }
    return repoDirs.get(r.path);
  };

  const rows = [];
  for (const u of units) {
    const repo = await repoFor(u);
    const checkout = findIssueCheckouts(config, { worktrees: repo.worktrees, branches: repo.branches }, u.id)[0] ?? null;
    const pr = checkout && repo.prs !== PR_UNKNOWN ? (repo.prs.get(checkout.branch) ?? null) : null;
    rows.push({ ...u, ...buckets.get(u.id), checkout, pr, repo });
  }

  L.push(`parent:   ${parent} — ${issue.title}   state: ${states.get(parent)}`);
  for (const [w, wave] of order.waves.entries()) {
    L.push(`wave ${w + 1}`);
    for (const id of wave) {
      const r = rows.find((x) => x.id === id);
      const bits = [];
      if (r.pr) bits.push(`PR #${r.pr.number} ${String(r.pr.state ?? '').toLowerCase()}`);
      if (r.checkout?.path) bits.push(r.checkout.path + (r.bucket === 'done' ? '   (stale — remove when convenient)' : ''));
      else if (r.checkout) bits.push(`branch ${r.checkout.branch} (not mounted)`);
      if (r.bucket === 'blocked') bits.push(`waits on ${r.waitsOn.join(', ')}`);
      if (r.bucket === 'unknown') bits.push(r.why);
      L.push(`  ${col(r.id, 8)} ${col(r.bucket, 12)} ${col(r.title, 40)} ${bits.join('   ')}`.replace(/\s+$/, ''));
    }
  }
  for (const e of order.external) {
    L.push(`note:     ${e.id} also depends on ${e.dependsOn.join(', ')}, outside this split`);
  }

  const ready = rows.filter((r) => r.bucket === 'ready');
  const inProgress = rows.filter((r) => r.bucket === 'in progress' && r.checkout?.path);
  const allDone = rows.every((r) => r.bucket === 'done');

  if (!opts.start && !opts.land) {
    if (allDone) L.push(`next:     every unit is done — close the parent: /dev-done ${parent}`);
    else if (ready.length) L.push(`next:     build ${parent} --start   — ${ready.length} unit(s) ready`);
    else if (inProgress.length) L.push(`next:     build ${parent} --land    — ${inProgress.length} unit(s) in progress`);
    else if (rows.some((r) => r.bucket === 'review')) L.push('next:     waiting on pull requests to merge — dev.mjs sync, then run this again');
    else L.push('next:     nothing is ready — see the units above');
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  if (opts.start) return start({ config, provider, vcs, parent, states, ready, L });
  return land({ config, parent, inProgress, rows, apply: opts.apply, vcs, L });
}

/** `--start`: mount every ready unit, serially, from the freshest base. */
async function start({ config, provider, vcs, parent, states, ready, L }) {
  const mode = config.branch?.mode ?? 'worktree';
  const base = config.branch?.base ?? 'main';

  if (!ready.length) {
    L.push('start:    nothing is ready');
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }
  if (mode !== 'worktree' && ready.filter((r) => !r.checkout?.path).length > 1) {
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
    L.push(moved.ok ? `parent:   moved to ${moved.state}` : `parent:   NOT MOVED — ${moved.error}`);
  }

  // Fork from what has actually landed. `fetch` failing is not fatal — offline,
  // the local base is the freshest base there is — but it is said.
  const forkFrom = new Map();
  const dispatch = [];
  for (const r of ready) {
    const repo = r.repo;
    if (!forkFrom.has(repo.path)) {
      const remote = deliveryFor(config, repo.path).remote ?? 'origin';
      const fresh = await vcs.freshestBase({ dir: repo.dir, remote, base });
      forkFrom.set(repo.path, fresh.ref);
      if (fresh.why) L.push(`note:     forking from local ${base} — ${fresh.why}`);
    }

    if (r.checkout?.path) {
      L.push(`mounted:  ${r.id} already at ${r.checkout.path}`);
      dispatch.push([r.id, r.checkout.path]);
      continue;
    }

    const started = await startIssue({
      config,
      provider,
      vcs,
      configured: { path: repo.path, dir: repo.dir },
      id: r.id,
      base: forkFrom.get(repo.path),
    });
    for (const line of started.lines) if (/^(branch|mode|forked|created|state|warning):/.test(line)) L.push(`  ${line}`);
    if (!started.moved) L.push(`  ${r.id} was mounted but not moved — retry: dev.mjs update ${r.id} state start`);
    if (started.dir) dispatch.push([r.id, started.dir]);
  }

  L.push('');
  for (const [id, path] of dispatch) L.push(`dispatch: ${id}\t${path}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

/** `--land`: hand each finished unit to `land`, then reconcile once. */
async function land({ config, parent, inProgress, rows, apply, vcs, L }) {
  const landable = [];
  for (const r of inProgress) {
    const clean = await vcs.isClean(r.checkout.path);
    if (clean.ok && !clean.clean) {
      L.push(`skipped:  ${r.id} has ${clean.dirty.length} uncommitted change(s) in ${r.checkout.path}`);
      continue;
    }
    landable.push(r);
  }
  for (const r of rows.filter((x) => x.bucket === 'in progress' && !x.checkout?.path)) {
    L.push(`skipped:  ${r.id} is in progress but checked out nowhere — dev.mjs resume ${r.id}`);
  }
  if (!landable.length) {
    L.push('land:     nothing to land');
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  L.push(`land:     ${landable.map((r) => r.id).join(', ')}${apply ? '' : '   (dry run — pass --apply)'}`);
  process.stdout.write(`${L.join('\n')}\n\n`);

  const { run: landRun } = await import('./land.mjs');
  for (const r of landable) {
    process.stdout.write(`--- ${r.id}\n`);
    const args = [r.id, '--repo', r.repo.path, ...(apply ? ['--apply'] : [])];
    // The reconcile is deferred to the end: one `sync --apply` for the wave,
    // not one per unit. A refusal stops the loop where it is — the units
    // before it have landed, the one that failed says why, the rest wait.
    const code = await landRun(args, { reconcile: false });
    if (code !== 0) {
      process.stderr.write(`dev build: ${r.id} did not land — stopping here; the units after it are untouched\n`);
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
