/**
 * Landing onto a branch that is not the fork point.
 *
 * The rest of the git layer is tested against a fake runner, because what is
 * worth pinning there is the argv. This file is deliberately the exception: the
 * claim being made is that `main` is left *untouched* while `develop` moves,
 * and a fake runner cannot fail that claim — it would happily report success for
 * a sequence of commands that merged into the wrong branch. So this drives real
 * git against a real repository, with a bare repo standing in for the remote so
 * nothing here touches a network.
 *
 * `delivery.base` earned this: the fork point and the delivery target were one
 * key until #6, so no existing test could ever have caught them being confused.
 *
 * The second half of the file asks a different question — not what `land` does
 * to the branches, but whether it can *find* the branch at all. That one is
 * about the whole command rather than the git layer, so it drives the real CLI
 * against the shared `gh` stub.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { missingTargetError } from '../scripts/cmd/land.mjs';
import { sh } from '../lib/sh.mjs';
import { makeVcs } from '../lib/vcs.mjs';
import { worktreePathFor } from '../lib/branch.mjs';
import { CONFIG, git as gitOf, withStubGh } from './ghstub.mjs';

const git = async (dir, ...args) => {
  const r = await sh('git', ['-C', dir, ...args]);
  if (!r.ok) throw new Error(`git ${args.join(' ')} in ${dir} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const head = (dir, ref) => git(dir, 'rev-parse', ref);

/**
 * A repository with `main` and `develop` both published to a bare remote, and a
 * ticket branch checked out in a worktree — the shape `land` actually runs in.
 */
async function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'land-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const wt = join(root, 'wt');

  await sh('git', ['init', '--bare', '-b', 'main', remote]);
  await sh('git', ['init', '-b', 'main', repo]);
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'commit', '--allow-empty', '-m', 'root');
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-u', 'origin', 'main');

  // develop starts level with main, as it would in a real gitflow repo.
  await git(repo, 'branch', 'develop');
  await git(repo, 'push', 'origin', 'develop');

  await git(repo, 'worktree', 'add', wt, '-b', 'feat/1-thing', 'main');
  await git(wt, 'config', 'user.email', 'test@example.invalid');
  await git(wt, 'config', 'user.name', 'Test');
  await git(wt, 'commit', '--allow-empty', '-m', 'feat: the work (#1)');

  return { root, remote, repo, wt, vcs: makeVcs({ run: sh }) };
}

test('direct delivery lands on delivery.base and leaves the fork point alone', async () => {
  const { repo, wt, vcs } = await scaffold();
  const mainBefore = await head(repo, 'main');
  const work = await head(wt, 'HEAD');

  const landed = await vcs.landDirect({
    repoDir: repo,
    workDir: wt,
    branch: 'feat/1-thing',
    base: 'develop',
    remote: 'origin',
    push: true,
  });

  assert.ok(landed.ok, `landDirect failed: ${landed.error}`);
  assert.equal(landed.base, 'develop');
  assert.equal(await head(repo, 'develop'), work, 'develop must carry the work');
  assert.equal(await head(repo, 'main'), mainBefore, 'the fork point must not move');
  assert.equal(
    await head(repo, 'refs/remotes/origin/develop'),
    work,
    'the push must have gone to the target, not the fork point',
  );
});

test('the main checkout is put back on the branch it was found on', async () => {
  // Without this, the repo root is silently left on `develop`. A later command
  // run there edits the wrong branch and reports a clean tree — the exact
  // failure worktree mode exists to avoid.
  const { repo, wt, vcs } = await scaffold();
  assert.equal(await git(repo, 'branch', '--show-current'), 'main');

  const landed = await vcs.landDirect({
    repoDir: repo,
    workDir: wt,
    branch: 'feat/1-thing',
    base: 'develop',
    remote: 'origin',
    push: true,
  });

  assert.ok(landed.ok, `landDirect failed: ${landed.error}`);
  assert.equal(await git(repo, 'branch', '--show-current'), 'main');
});

test('the reported head is the target that was landed onto, not the restored branch', async () => {
  const { repo, wt, vcs } = await scaffold();
  const landed = await vcs.landDirect({
    repoDir: repo,
    workDir: wt,
    branch: 'feat/1-thing',
    base: 'develop',
    remote: 'origin',
    push: true,
  });

  assert.ok(landed.ok, `landDirect failed: ${landed.error}`);
  const develop = await head(repo, 'develop');
  assert.ok(
    develop.startsWith(landed.head),
    `reported ${landed.head}, but develop is at ${develop} — the read-back ran after the restore`,
  );
});

test('landing onto the fork point still works and leaves the checkout on it', async () => {
  // The no-delivery.base path, which every existing project is on.
  const { repo, wt, vcs } = await scaffold();
  const work = await head(wt, 'HEAD');

  const landed = await vcs.landDirect({
    repoDir: repo,
    workDir: wt,
    branch: 'feat/1-thing',
    base: 'main',
    remote: 'origin',
    push: true,
  });

  assert.ok(landed.ok, `landDirect failed: ${landed.error}`);
  assert.equal(await head(repo, 'main'), work);
  assert.equal(await git(repo, 'branch', '--show-current'), 'main', 'nothing to restore');
});

// --- the config error ---------------------------------------------------------

test('a missing target names the key that produced it', () => {
  const fromDelivery = missingTargetError({
    base: 'develop',
    remote: 'origin',
    repoDir: '/r',
    fromDeliveryBase: true,
  });
  assert.match(fromDelivery, /"develop" does not exist/);
  assert.match(fromDelivery, /origin\/develop/, 'the remote-tracking ref was checked too — say so');
  assert.match(fromDelivery, /delivery\.base/);
  assert.doesNotMatch(fromDelivery, /It comes from branch\.base/);

  const fromBranch = missingTargetError({
    base: 'trunk',
    remote: 'origin',
    repoDir: '/r',
    fromDeliveryBase: false,
  });
  assert.match(fromBranch, /branch\.base/);
  assert.match(fromBranch, /set delivery\.base/, 'point at the fix, not just the cause');
});

// --- finding the branch (#15) -------------------------------------------------

/**
 * A multi-repo project in worktree mode used to be a closed loop: `--repo` takes
 * only the paths in `repos`, and the branch lives in a worktree *under* one of
 * them, so no spelling of the flag ever named the checkout holding the work.
 * Every test here runs the real command with no `--repo` at all.
 */
const PR_MODE = { ...CONFIG, delivery: { mode: 'pr' }, reviewer: 'octocat' };

test('land finds the branch from a worktree in a multi-repo project, with no --repo', async () => {
  const { repo, wt, dev } = await withStubGh({ repos: ['api', 'web'], config: PR_MODE });

  // The claim is about a worktree `dev.mjs start` would have made, so pin that
  // the scaffold built the directory `start` renders rather than one that merely
  // looks like it.
  assert.equal(wt, worktreePathFor(CONFIG, { repoDir: repo, branch: 'feat/12-thing' }));

  const r = await dev(['land'], {}, { cwd: wt });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /issue: +#12 — Half a thing/);
  assert.match(r.stdout, /repo: +web /, 'the repo came from the directory, not the first entry');
  assert.match(r.stdout, /branch: +feat\/12-thing → main/);
  assert.match(r.stdout, /reviewer: octocat/, 'the plan must be checkable against the config');
  assert.match(r.stdout, /dry run/);
});

test('the dry run of a project with no reviewer says so rather than omitting the line', async () => {
  const { wt, dev } = await withStubGh({
    repos: ['api', 'web'],
    config: { ...CONFIG, delivery: { mode: 'pr' } },
  });

  const r = await dev(['land'], {}, { cwd: wt });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /reviewer: \(none configured\)/);
});

test('land --apply from that worktree pushes, opens the PR and reconciles the ticket', async () => {
  // The dry run proves nothing about a write path. `gh` is a stub and cannot
  // prove anything about the API — but the push is real git against a bare
  // remote, and the argv and the ordering are what the log holds.
  const openPr = {
    number: 7,
    state: 'OPEN',
    title: 'Half a thing',
    url: 'https://github.com/o/r/pull/7',
    headRefName: 'feat/12-thing',
    createdAt: new Date().toISOString(),
  };
  const { repo, wt, dev, read } = await withStubGh({
    repos: ['api', 'web'],
    remote: true,
    config: PR_MODE,
    prsByState: { merged: [], open: [openPr] },
  });

  const r = await dev(['land', '--apply'], {}, { cwd: wt });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    await gitOf(repo, 'rev-parse', 'origin/feat/12-thing'),
    await gitOf(wt, 'rev-parse', 'HEAD'),
    'the branch must be on the remote',
  );

  const log = read('log');
  assert.match(log, /pr create --base main --head feat\/12-thing/);
  assert.match(log, /--reviewer octocat/);
  assert.match(r.stdout, /pr: +#7 https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(read('state'), /status: in review/, 'the ticket must reach the review rung');
});

test('branch mode still resolves the repo from the directory it is run in', async () => {
  // No worktree anywhere: the ticket branch is checked out in the repo itself,
  // which is what `branch` mode leaves behind.
  const { repo, wt, dev } = await withStubGh({ repos: ['api', 'web'], config: PR_MODE });
  await gitOf(repo, 'worktree', 'remove', '--force', wt);
  await gitOf(repo, 'checkout', 'feat/12-thing');

  const r = await dev(['land'], {}, { cwd: repo });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /repo: +web /);
  assert.match(r.stdout, /branch: +feat\/12-thing → main/);
  assert.doesNotMatch(r.stdout, /checkout: worktree/);
});

test('a single-repo project still lands with no --repo', async () => {
  const { wt, dev } = await withStubGh({ config: PR_MODE });

  const r = await dev(['land'], {}, { cwd: wt });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /repo: +\. /);
  assert.match(r.stdout, /branch: +feat\/12-thing → main/);
});

test('standing on the base branch says where the work actually is', async () => {
  // The second command in #15's transcript: `--repo web` is answered by the repo
  // root, which is where worktree mode leaves the base checked out. "Nothing to
  // land" was true and useless.
  const { repo, dev } = await withStubGh({ repos: ['api', 'web'], config: PR_MODE });

  const r = await dev(['land', '#12', '--repo', 'web'], {}, { cwd: repo });

  // Matched by shape rather than against the scaffold's own path: git reports
  // the worktree resolved through symlinks, and the temporary directory on
  // macOS is one.
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already on main/);
  assert.match(r.stderr, /#12 is checked out in \S+\/web\/\.worktrees\/feat-12-thing/);
  assert.match(r.stderr, /cd \S+\/web\/\.worktrees\/feat-12-thing/);
});
