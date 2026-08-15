/**
 * Get finished work onto the base branch, the way this project delivers.
 *
 *   dev.mjs land [ISSUE-ID] [--apply] [--repo PATH]
 *
 * Which of the two things happens is `delivery.mode`, not a judgement call made
 * per session: `pr` opens a pull request and lets the reconciler move the
 * ticket, `direct` rebases, fast-forwards the base and pushes. A solo project
 * configures `direct` once and never argues with a review gate again.
 *
 * Dry run unless `--apply`. The dry run is a courtesy, not a proof — this repo
 * has shipped a write path whose plan was perfect and whose command the API
 * rejected, so `--apply` is the only thing that demonstrates the write works.
 */
import { issueIdFromBranch } from '../../lib/branch.mjs';
import { deliveryFor } from '../../lib/config.mjs';
import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, resolveRepo, UserError } from './common.mjs';

function parseArgs(args) {
  const opts = { apply: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--repo') opts.repo = args[++i];
    else if (a.startsWith('-')) throw new UserError(`unknown flag ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

/** Open the PR and report what actually landed on it, not what was requested. */
async function openPullRequest({ workDir, branch, base, issue, reviewer, remote, apply, L }) {
  L.push(`action:   open a pull request ${branch} → ${base}`);
  if (!apply) return { ok: true };

  const push = await sh('git', ['-C', workDir, 'push', '--set-upstream', remote, branch]);
  if (!push.ok) throw new UserError(`pushing ${branch} to ${remote} failed:\n${push.stderr}`);
  L.push(`push:     ${remote} ${branch}`);

  const body = `${issue.body ? `${issue.body}\n\n---\n\n` : ''}Closes ${issue.id} — ${issue.url}`;
  const args = ['pr', 'create', '--base', base, '--head', branch, '--title', issue.title, '--body-file', '-'];
  if (reviewer) args.push('--reviewer', reviewer);

  const created = await sh('gh', args, { cwd: workDir, input: body });

  // `gh pr create` reports failure for pull requests it in fact created, so the
  // exit code is not the answer — the PR is. Read it back either way.
  const view = await sh(
    'gh',
    ['pr', 'view', branch, '--json', 'number,url,title,reviewRequests'],
    { cwd: workDir },
  );
  if (!view.ok) {
    throw new UserError(
      `could not confirm a pull request for ${branch}: ${view.stderr || 'no PR found'}\n` +
        (created.ok ? '' : `gh pr create said: ${created.stderr}`),
    );
  }

  const pr = JSON.parse(view.stdout);
  L.push(`pr:       #${pr.number} ${pr.url}`);
  const requested = (pr.reviewRequests ?? []).map((r) => r.login ?? r.name).filter(Boolean);
  if (reviewer && !requested.includes(reviewer)) {
    L.push(`warning:  reviewer ${reviewer} was requested but is not on the PR — add them by hand`);
  }
  return { ok: true, url: pr.url };
}

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  const { config, root, provider } = await context();
  const repo = resolveRepo(config, root, opts.repo);
  const vcs = makeVcs({ run: sh });

  // Run from wherever the caller is when that is a checkout of this repo: in
  // worktree mode the branch is not on the repo root, and reading the branch
  // there would report the base and land nothing.
  const cwd = process.cwd();
  const cwdBranch = await vcs.currentBranch(cwd);
  const branch = cwdBranch ?? (await vcs.currentBranch(repo.dir));
  if (!branch) throw new UserError('HEAD is detached — check out the ticket branch first');
  const workDir = cwdBranch ? cwd : repo.dir;

  // `.dev-workflow.json` is tracked, so a worktree carries a copy and the config
  // walk resolves the project root to the worktree when this runs from inside
  // one. The base branch is checked out in the main checkout, not here, and
  // merging into it from the wrong side fails with "'main' is already used by
  // worktree at …".
  const repoDir = await vcs.mainCheckout(workDir);

  const id = rest[0] ?? issueIdFromBranch(config, branch);
  if (!id) {
    throw new UserError(
      `could not read an issue ID out of the branch "${branch}" — pass one: dev.mjs land <ISSUE-ID>`,
    );
  }

  const base = config.branch?.base ?? 'main';
  if (branch === base) throw new UserError(`already on ${base} — there is nothing to land`);

  const issue = await provider.getIssue(id);
  if (!issue.ok) throw new UserError(issue.error);

  const delivery = deliveryFor(config, repo.path);
  const L = [];
  L.push(`issue:    ${id} — ${issue.data.title}`);
  L.push(`repo:     ${repo.path} (${workDir})`);
  if (workDir !== repoDir) L.push(`checkout: worktree; base lives in ${repoDir}`);
  L.push(`branch:   ${branch} → ${base}`);
  L.push(`delivery: ${delivery.mode}${opts.apply ? '' : '   (dry run — pass --apply)'}`);

  if (delivery.mode === 'pr') {
    await openPullRequest({
      workDir,
      branch,
      base,
      issue: issue.data,
      reviewer: config.reviewer,
      remote: delivery.remote ?? 'origin',
      apply: opts.apply,
      L,
    });

    if (opts.apply) {
      // The reconciler is the one code path that knows how an open PR maps onto
      // a rung. Duplicating that mapping here is how the two drift.
      process.stdout.write(`${L.join('\n')}\n\n`);
      const { run: syncRun } = await import('./sync.mjs');
      let code;
      try {
        code = await syncRun(['--apply']);
      } catch (err) {
        code = 1;
        process.stderr.write(`dev land: ${err.message}\n`);
      }
      if (code !== 0) {
        // The pull request exists either way — saying only that the reconcile
        // failed reads as "nothing happened", and someone opens a second PR.
        process.stderr.write(
          `dev land: the pull request was created, but the ticket was not reconciled.\n` +
            `Move it by hand: dev.mjs update ${id} state review "<PR url>"\n`,
        );
      }
      return code;
    }
    L.push('then:     dev.mjs sync --apply moves the ticket to the review state');
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  if (delivery.mode !== 'direct') {
    throw new UserError(`unknown delivery.mode "${delivery.mode}" — expected "pr" or "direct"`);
  }

  L.push(
    `action:   rebase onto ${base}, fast-forward, ` +
      (delivery.push === false ? 'no push' : `push to ${delivery.remote ?? 'origin'}`),
  );
  if (delivery.cleanup !== false) {
    L.push(
      `cleanup:  ${workDir === repoDir ? 'delete the branch' : 'remove the worktree and delete the branch'}`,
    );
  }

  if (!opts.apply) {
    L.push('', '(dry run — nothing was changed)');
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  const landed = await vcs.landDirect({
    repoDir,
    workDir,
    branch,
    base,
    remote: delivery.remote ?? 'origin',
    push: delivery.push !== false,
  });
  if (!landed.ok) throw new UserError(landed.error);
  for (const s of landed.steps) L.push(`          ${s}`);
  L.push(`landed:   ${base} at ${landed.head}`);

  if (delivery.cleanup !== false) {
    const worktreeDir = config.branch?.worktreeDir ?? '.worktrees';
    const cleaned = await vcs.cleanupWork({
      repoDir,
      worktreePath: workDir === repoDir ? null : workDir,
      branch,
      worktreeRoot: `${repoDir}/${worktreeDir}`,
    });
    if (!cleaned.ok) throw new UserError(cleaned.error);
    for (const n of cleaned.notes) L.push(`          ${n}`);
  }

  const moved = await provider.setState(id, 'done');
  L.push(moved.ok ? `state:    ${moved.state}` : `state:    NOT MOVED — ${moved.error}`);

  if (workDir !== repoDir) L.push('', `cd ${repoDir}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return moved.ok ? 0 : 1;
}
