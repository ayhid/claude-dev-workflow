/**
 * `dev.mjs start` forks from the freshest base it can see (#122).
 *
 * The local base branch is where a shared root checkout was left, which on a
 * long-lived checkout is always behind. `build --start` and `land` already
 * fetch and fork from `origin/<base>`; `start` was the one path that did not,
 * so a single-unit ticket began a release behind what had landed. Every case
 * here also proves the local base branch itself was not moved.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sh } from '../lib/sh.mjs';
import { CONFIG, git, withStubGh } from './ghstub.mjs';

const CFG = { ...CONFIG, branch: { pattern: '<ID>-<slug>', base: 'main', mode: 'worktree' } };
const ISSUES = () => ({
  42: { number: 42, title: 'Thing', body: '', state: 'OPEN', stateReason: null, url: 'https://github.com/o/r/issues/42', labels: [], subIssues: [] },
});

const head = (dir, ref) => git(dir, 'rev-parse', ref);

test('start forks from origin/<base> when the remote is ahead, and says so', async () => {
  const { repo, dev } = await withStubGh({ config: CFG, issues: ISSUES(), remote: true });
  const localMain = await head(repo, 'main');

  // The remote moved on, as it does after every merge nobody pulled.
  const scratch = join(repo, '..', 'scratch-clone');
  await sh('git', ['clone', '-q', join(repo, '..', 'repo.git'), scratch]);
  await git(scratch, 'config', 'user.email', 't@example.invalid');
  await git(scratch, 'config', 'user.name', 'T');
  writeFileSync(join(scratch, 'landed.txt'), 'landed\n');
  await git(scratch, 'add', 'landed.txt');
  await git(scratch, 'commit', '-q', '-m', 'feat(x): landed elsewhere (#41)');
  await git(scratch, 'push', '-q', 'origin', 'main');

  const r = await dev(['start', '#42']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forked: +origin\/main$/m);
  const wt = join(repo, '.worktrees', '42-thing');
  assert.ok(existsSync(join(wt, 'landed.txt')), 'the ticket forked from the fetched remote base');
  assert.equal(await head(wt, 'HEAD'), await head(repo, 'origin/main'));
  assert.equal(await head(repo, 'main'), localMain, 'the local base branch is never moved');
});

test('start with no remote forks from the local base and says why', async () => {
  const { repo, dev } = await withStubGh({ config: CFG, issues: ISSUES(), remote: false });
  const localMain = await head(repo, 'main');

  const r = await dev(['start', '#42']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forked: +main — no remote "origin"$/m);
  assert.equal(await head(join(repo, '.worktrees', '42-thing'), 'HEAD'), localMain);
  assert.equal(await head(repo, 'main'), localMain);
});

test('start with a remote it cannot fetch forks locally, prints the reason, and still exits 0', async () => {
  const { repo, dev } = await withStubGh({ config: CFG, issues: ISSUES(), remote: true });
  const localMain = await head(repo, 'main');
  await git(repo, 'remote', 'set-url', 'origin', join(repo, '..', 'gone.git'));

  const r = await dev(['start', '#42']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forked: +main — could not fetch origin\/main: .+/m);
  assert.equal(await head(join(repo, '.worktrees', '42-thing'), 'HEAD'), localMain);
  assert.equal(await head(repo, 'main'), localMain);
});
