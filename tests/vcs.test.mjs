/**
 * The git layer, driven by a fake runner.
 *
 * Every assertion here is about the **argv** that would reach git, not about a
 * repository — which is the whole reason `makeVcs` takes its runner as an
 * argument. The guarantees worth testing are the ones a reader cannot verify by
 * eye later: that no call ever skips a hook, and that a conflict never gets
 * force-resolved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeVcs } from '../lib/vcs.mjs';

/**
 * A runner that answers from a table and records everything it was asked.
 * `replies` maps a substring of the joined argv to a result.
 */
function fakeRun(replies = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const key = Object.keys(replies).find((k) => args.join(' ').includes(k));
    const r = key ? replies[key] : {};
    return { ok: r.ok ?? true, code: r.code ?? (r.ok === false ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  run.calls = calls;
  return run;
}

test('every git call is an argv array, never a shell string', async () => {
  const run = fakeRun({ 'branch --show-current': { stdout: 'feat/1-x' } });
  const vcs = makeVcs({ run });
  await vcs.currentBranch('/repo');
  assert.deepEqual(run.calls, ['git -C /repo branch --show-current']);
});

test('a hook bypass is refused at the choke point', () => {
  const vcs = makeVcs({ run: fakeRun() });
  assert.throws(() => vcs.git('/repo', ['commit', '--no-verify', '-m', 'x']), /never bypasses hooks/);
});

test('force-resolving a conflict is refused in every spelling', () => {
  const vcs = makeVcs({ run: fakeRun() });
  for (const args of [
    ['merge', '-X', 'theirs', 'b'],
    ['merge', '-Xtheirs', 'b'],
    ['merge', '--strategy-option=theirs', 'b'],
    ['checkout', '--theirs', '.'],
  ]) {
    assert.throws(() => vcs.git('/repo', args), /force-resolve/, args.join(' '));
  }
});

test('--dry-run is not mistaken for a hook bypass', () => {
  // `-n` means --dry-run to git push; blocking it would be exactly backwards.
  const vcs = makeVcs({ run: fakeRun() });
  assert.doesNotThrow(() => vcs.git('/repo', ['push', '-n', 'origin', 'main']));
});

test('isClean ignores the workflow config it is about to be reconfigured by', async () => {
  const run = fakeRun();
  const vcs = makeVcs({ run });
  await vcs.isClean('/repo');
  assert.match(run.calls[0], /:\(exclude\)\.dev-workflow\.json/);
});

test('branch mode refuses to switch a dirty tree', async () => {
  const run = fakeRun({
    'rev-parse --verify --quiet refs/heads/feat/1-x': { ok: false },
    'rev-parse --verify --quiet main': { stdout: 'abc' },
    'status --porcelain': { stdout: ' M src/app.js' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.startWork({ dir: '/repo', branch: 'feat/1-x', base: 'main', mode: 'branch' });
  assert.equal(r.ok, false);
  assert.match(r.error, /uncommitted changes/);
  assert.match(r.error, /worktree mode/);
  assert.ok(!run.calls.some((c) => c.includes('switch')), 'must not switch');
});

test('worktree mode creates the worktree from the base and reads the branch back', async () => {
  const run = fakeRun({
    'rev-parse --verify --quiet refs/heads/feat/1-x': { ok: false },
    'rev-parse --verify --quiet main': { stdout: 'abc' },
    'worktree list': { stdout: 'worktree /repo\n' },
    'branch --show-current': { stdout: 'feat/1-x' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.startWork({
    dir: '/repo',
    branch: 'feat/1-x',
    base: 'main',
    mode: 'worktree',
    worktreePath: '/repo/.worktrees/feat-1-x',
  });
  assert.deepEqual(r, {
    ok: true,
    mode: 'worktree',
    branch: 'feat/1-x',
    dir: '/repo/.worktrees/feat-1-x',
    created: true,
  });
  assert.ok(
    run.calls.includes('git -C /repo worktree add -b feat/1-x /repo/.worktrees/feat-1-x main'),
    run.calls.join('\n'),
  );
});

test('an already-mounted worktree is reused, not recreated', async () => {
  const run = fakeRun({
    'rev-parse --verify --quiet refs/heads/feat/1-x': { stdout: 'abc' },
    'worktree list': { stdout: 'worktree /repo\nworktree /repo/.worktrees/feat-1-x\n' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.startWork({
    dir: '/repo',
    branch: 'feat/1-x',
    base: 'main',
    mode: 'worktree',
    worktreePath: '/repo/.worktrees/feat-1-x',
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.ok(!run.calls.some((c) => c.includes('worktree add')), 'must not re-add');
});

test('mainCheckout finds the checkout holding the base, from inside a worktree', async () => {
  // The config file is tracked, so a worktree carries a copy and the config walk
  // resolves the project root to the worktree. Merging into the base from there
  // fails with "'main' is already used by worktree at …" — because it is.
  const run = fakeRun({
    'worktree list': { stdout: 'worktree /repo\nHEAD abc\n\nworktree /repo/.worktrees/feat-1-x\n' },
  });
  const vcs = makeVcs({ run });
  assert.equal(await vcs.mainCheckout('/repo/.worktrees/feat-1-x'), '/repo');
});

test('landDirect rebases, fast-forwards and pushes', async () => {
  const run = fakeRun({
    'remote get-url origin': { stdout: 'git@github.com:o/r.git' },
    'rev-parse --verify --quiet origin/main': { stdout: 'abc' },
    'branch --show-current': { stdout: 'main' },
    'rev-parse --short HEAD': { stdout: 'deadbee' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.landDirect({
    repoDir: '/repo',
    workDir: '/repo/.worktrees/feat-1-x',
    branch: 'feat/1-x',
    base: 'main',
    remote: 'origin',
    push: true,
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.head, 'deadbee');
  assert.ok(run.calls.includes('git -C /repo/.worktrees/feat-1-x rebase origin/main'));
  assert.ok(run.calls.includes('git -C /repo merge --ff-only feat/1-x'));
  assert.ok(run.calls.includes('git -C /repo push origin main'));
  // The base is already checked out in the main worktree; nothing switches.
  assert.ok(!run.calls.some((c) => c.includes('switch')));
});

test('a rebase conflict aborts, reports, and changes nothing', async () => {
  const run = fakeRun({
    'remote get-url origin': { ok: false },
    rebase: { ok: false, stderr: 'CONFLICT (content): src/app.js' },
    'branch --show-current': { stdout: 'main' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.landDirect({
    repoDir: '/repo',
    workDir: '/repo',
    branch: 'feat/1-x',
    base: 'main',
    push: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /CONFLICT/);
  assert.match(r.error, /the branch is unchanged/);
  assert.ok(run.calls.includes('git -C /repo rebase --abort'));
  assert.ok(!run.calls.some((c) => c.includes('merge')), 'must not merge after a conflict');
});

test('landDirect refuses to land uncommitted work', async () => {
  const run = fakeRun({ 'status --porcelain': { stdout: '?? src/new.js' } });
  const vcs = makeVcs({ run });
  const r = await vcs.landDirect({ repoDir: '/repo', workDir: '/repo', branch: 'b', base: 'main' });
  assert.equal(r.ok, false);
  assert.match(r.error, /uncommitted changes/);
});

test('cleanup escalates to --force before giving up on the plain remove', async () => {
  const run = fakeRun({
    // Listed first so the forced form matches its own key rather than the
    // plain one's substring.
    'worktree remove --force': { ok: true },
    'worktree remove /repo/.worktrees/x': { ok: false, stderr: 'contains modified files' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.cleanupWork({
    repoDir: '/repo',
    worktreePath: '/repo/.worktrees/x',
    branch: 'feat/1-x',
    worktreeRoot: '/repo/.worktrees',
  });
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => n.includes('--force')));
});

test('cleanup refuses to delete outside the configured worktree root', async () => {
  const run = fakeRun({ 'worktree remove': { ok: false, stderr: 'nope' } });
  const vcs = makeVcs({ run });
  const r = await vcs.cleanupWork({
    repoDir: '/repo',
    worktreePath: '/etc',
    branch: null,
    worktreeRoot: '/repo/.worktrees',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /refusing to delete \/etc/);
});

test('an unmerged branch is kept and said so, not force-deleted', async () => {
  const run = fakeRun({ 'branch -d': { ok: false, stderr: 'not fully merged' } });
  const vcs = makeVcs({ run });
  const r = await vcs.cleanupWork({ repoDir: '/repo', worktreePath: null, branch: 'feat/1-x' });
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => n.includes('kept')));
  assert.ok(!run.calls.some((c) => c.includes('branch -D')), 'never force-delete');
});
