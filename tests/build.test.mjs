/**
 * `dev.mjs build` end to end, against the table-mode `gh` stub (#103).
 *
 * The board is a read; `--start` and `--land` are writes with an order that the
 * stub's log and the real git repository can prove: which units got a
 * worktree, what they forked from, which ticket moved, and that a wave lands
 * with one reconcile rather than one per unit.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sh } from '../lib/sh.mjs';
import { CONFIG, git, withStubGh } from './ghstub.mjs';

const issue = (number, title, over = {}) => ({
  number,
  title,
  body: '',
  state: 'OPEN',
  stateReason: null,
  url: `https://github.com/o/r/issues/${number}`,
  labels: [],
  subIssues: [],
  ...over,
});

/** A parent split three ways: 43 and 44 independent, 45 after both. */
const SPLIT = () => ({
  12: issue(12, 'Half a thing', { subIssues: [43, 44, 45], labels: [] }),
  43: issue(43, 'Parser'),
  44: issue(44, 'Renderer'),
  45: issue(45, 'Wiring', { body: 'Depends on: #43, #44' }),
});

const CFG = { ...CONFIG, branch: { pattern: '<ID>-<slug>', base: 'main', mode: 'worktree' }, delivery: { mode: 'pr' } };

test('the board classifies every unit and says what to do next', async () => {
  const table = SPLIT();
  table[43].state = 'CLOSED';
  table[43].stateReason = 'COMPLETED';
  table[44].labels = ['status: in review'];
  const { dev } = await withStubGh({ config: CFG, issues: table, prs: [] });

  const r = await dev(['build', '#12']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /parent: +#12 — Half a thing +state: Backlog/);
  assert.match(r.stdout, /wave 1\n +#43 +done +Parser\n +#44 +review +Renderer\nwave 2\n +#45 +blocked +Wiring +waits on #44/);
  assert.match(r.stdout, /next: +waiting on pull requests to merge/);
});

test('a ticket that was never split says so instead of inventing a board', async () => {
  const { dev } = await withStubGh({ config: CFG, issues: { 12: issue(12, 'Half a thing') } });

  const r = await dev(['build', '#12']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /children: none/);
  assert.match(r.stdout, /dev\.mjs start #12/);
});

test('--start mounts the ready units only, off the remote base, and prints one dispatch line each', async () => {
  const { repo, dev, issues, read } = await withStubGh({ config: CFG, issues: SPLIT(), remote: true });

  // The remote base moved on: what a merged wave looks like from here.
  const scratch = join(repo, '..', 'scratch-clone');
  await sh('git', ['clone', '-q', join(repo, '..', 'repo.git'), scratch]);
  await git(scratch, 'config', 'user.email', 't@example.invalid');
  await git(scratch, 'config', 'user.name', 'T');
  writeFileSync(join(scratch, 'landed.txt'), 'wave 1\n');
  await git(scratch, 'add', 'landed.txt');
  await git(scratch, 'commit', '-q', '-m', 'feat(x): landed elsewhere (#43)');
  await git(scratch, 'push', '-q', 'origin', 'main');

  const r = await dev(['build', '#12', '--start']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /parent: +moved to In Progress/);
  assert.match(r.stdout, /dispatch: #43\t\S+\/\.worktrees\/43-parser\n/);
  assert.match(r.stdout, /dispatch: #44\t\S+\/\.worktrees\/44-renderer\n/);
  assert.doesNotMatch(r.stdout, /dispatch: #45/, 'a blocked unit is not started');

  // Mounted, forked from origin/main, which carries the commit local main does not.
  const wt43 = join(repo, '.worktrees', '43-parser');
  assert.ok(existsSync(join(wt43, 'landed.txt')), 'the unit forked from the fetched remote base');
  assert.ok(!existsSync(join(repo, 'landed.txt')), 'local main was not moved');
  assert.ok(!existsSync(join(repo, '.worktrees', '45-wiring')));

  // The tracker: both ready units and the parent moved to the start rung.
  const table = issues();
  assert.deepEqual(table[43].labels, ['status: in progress']);
  assert.deepEqual(table[44].labels, ['status: in progress']);
  assert.deepEqual(table[12].labels, ['status: in progress']);
  assert.deepEqual(table[45].labels, []);

  // One provider for the whole wave, so one `gh auth status`, not one per unit.
  assert.equal(read('log').split('\n').filter((l) => l === 'auth status').length, 1);

  // Run again: nothing new is created, the mounted units are reported as such.
  const again = await dev(['build', '#12']);
  assert.match(again.stdout, /#43 +in progress +Parser +\S+\/43-parser/);
  assert.match(again.stdout, /next: +build #12 --land/);
});

test('--start refuses in branch mode when more than one unit is ready, naming the key', async () => {
  const branchMode = { ...CFG, branch: { ...CFG.branch, mode: 'branch' } };
  const { repo, dev, issues } = await withStubGh({ config: branchMode, issues: SPLIT() });

  const r = await dev(['build', '#12', '--start']);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /branch\.mode is "branch"/);
  assert.match(r.stderr, /2 units are ready/);
  assert.equal(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'nothing was switched');
  assert.deepEqual(issues()[12].labels, [], 'the parent was not moved either');
});

test('--land dry-runs the finished units, skips a dirty one, and --apply lands the wave with one reconcile', async () => {
  const table = SPLIT();
  table[43].labels = ['status: in progress'];
  table[44].labels = ['status: in progress'];
  table[12].labels = ['status: in progress'];
  const openPr = (n, branch) => ({ number: n, state: 'OPEN', title: 'x', url: `https://github.com/o/r/pull/${n}`, headRefName: branch, createdAt: new Date().toISOString() });
  const { repo, dev, read } = await withStubGh({
    // `sync` names the GitHub slug from `repos[].github` when the remote is a
    // bare path rather than a forge URL, which the scaffold's is.
    config: { ...CFG, repos: [{ path: '.', github: 'o/r' }] },
    issues: table,
    remote: true,
    prsByState: { merged: [], open: [openPr(70, '43-parser'), openPr(71, '44-renderer')] },
  });

  // Two units mounted with work on them, one of them dirty.
  for (const [n, slug] of [[43, '43-parser'], [44, '44-renderer']]) {
    const wt = join(repo, '.worktrees', slug);
    await git(repo, 'worktree', 'add', '-q', wt, '-b', slug, 'main');
    await git(wt, 'commit', '-q', '--allow-empty', '-m', `feat(x): unit (#${n})`);
  }
  writeFileSync(join(repo, '.worktrees', '44-renderer', 'wip.txt'), 'not committed\n');

  const dry = await dev(['build', '#12', '--land']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /skipped: +#44 has 1 uncommitted change/);
  assert.match(dry.stdout, /land: +#43 +\(dry run/);
  assert.match(dry.stdout, /--- #43\n[\s\S]*branch: +43-parser → main/);
  assert.doesNotMatch(read('log'), /pr create/);

  const applied = await dev(['build', '#12', '--land', '--apply']);
  assert.equal(applied.code, 0, applied.stderr);
  const log = read('log');
  assert.equal(log.split('\n').filter((l) => l.startsWith('pr create')).length, 1, 'one PR for the one clean unit');
  assert.match(log, /pr create --base main --head 43-parser/);
  // Exactly one reconcile for the wave: `sync --apply` reads the PR list once
  // for merged and once for open; a per-unit reconcile would double that.
  assert.equal(log.split('\n').filter((l) => /^pr list -R o\/r --state (merged|open)/.test(l)).length, 2);
  assert.match(applied.stdout, /next: +when the pull requests merge/);
  assert.equal(
    await git(repo, 'rev-parse', 'origin/43-parser'),
    await git(join(repo, '.worktrees', '43-parser'), 'rev-parse', 'HEAD'),
    'the unit is on the remote',
  );
});

test('--land from the project root lands worktrees it is not standing in, and the metrics log stays in the main checkout', async () => {
  const table = SPLIT();
  table[43].labels = ['status: in progress'];
  const direct = { ...CFG, delivery: { mode: 'direct', push: false } };
  const { repo, dev, projectRoot } = await withStubGh({ config: direct, issues: table });

  const wt = join(repo, '.worktrees', '43-parser');
  await git(repo, 'worktree', 'add', '-q', wt, '-b', '43-parser', 'main');
  writeFileSync(join(wt, 'parser.txt'), 'done\n');
  await git(wt, 'add', 'parser.txt');
  await git(wt, 'commit', '-q', '-m', 'feat(x): parser (#43)');

  const r = await dev(['build', '#12', '--land', '--apply'], {}, { cwd: repo });

  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(repo, 'parser.txt')), 'the unit landed on the base');
  assert.ok(!existsSync(wt), 'direct delivery removed the worktree');
  const log = readFileSync(join(projectRoot, '.dev-workflow.metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => [e.event, e.id]), [['done', '#43']]);
  assert.ok(!existsSync(join(wt, '.dev-workflow.metrics.jsonl')));
});
