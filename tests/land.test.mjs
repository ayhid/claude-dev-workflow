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
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { missingTargetError } from '../scripts/cmd/land.mjs';
import { sh } from '../lib/sh.mjs';
import { makeVcs } from '../lib/vcs.mjs';

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
