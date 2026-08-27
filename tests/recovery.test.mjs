/**
 * The recovery verbs: `dev.mjs abandon` and `dev.mjs resume` (#28).
 *
 * Split the way the rest of the repo splits: the decisions — which branch
 * belongs to a ticket, what the ticket gets told, whether it is behind — are
 * pure and asserted directly, and the destructive half is driven against a real
 * repository, for the reason `tests/land.test.mjs` gives. A fake runner cannot
 * fail the claim being made here. It would happily report success for a
 * sequence that deleted an unmerged branch, which is exactly what must not
 * happen without `--force`.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findIssueCheckouts } from '../lib/branch.mjs';
import { DEFAULTS, deepMerge, resolveRung } from '../lib/config.mjs';
import { abandonComment } from '../scripts/cmd/abandon.mjs';
import { stateGap } from '../scripts/cmd/resume.mjs';
import { git, scaffold, withStubGh } from './ghstub.mjs';

const gh = (patch = {}) =>
  deepMerge(DEFAULTS, { provider: 'github', github: { repo: 'o/r' }, ...patch });
const yt = (patch = {}) => deepMerge(DEFAULTS, { provider: 'youtrack', project: 'ABC', ...patch });

// --- where a ticket goes when its work is thrown away --------------------------

test('the abandon rung comes from config, and an unset one names the key', () => {
  assert.deepEqual(resolveRung(gh({ states: { abandon: 'Backlog' } }), 'abandon'), {
    ok: true,
    state: 'Backlog',
  });

  const unset = resolveRung(gh(), 'abandon');
  assert.equal(unset.ok, false);
  assert.match(unset.error, /states\.abandon/, 'name the key to add, never guess a state');
});

test('an unconfigured abandon rung is never inferred from the ladder', () => {
  // The derived ladder is [start, review, done], so ladder[0] is "In Progress" —
  // walking a ticket back to the state it is already in, silently. That is the
  // guess rule 2 exists to refuse, and it must stay refused.
  const config = yt();
  assert.equal(resolveRung(config, 'abandon').ok, false);
  assert.equal(config.states.abandon, null);
});

// --- finding the ticket's checkout --------------------------------------------

const worktrees = [
  { path: '/r', branch: 'main' },
  { path: '/r/.worktrees/feat-12-thing', branch: 'feat/12-thing' },
];
const branches = ['main', 'feat/12-thing', 'fix/13-other'];

test('a mounted branch is found with its path', () => {
  assert.deepEqual(findIssueCheckouts(gh(), { worktrees, branches }, '#12'), [
    { branch: 'feat/12-thing', path: '/r/.worktrees/feat-12-thing' },
  ]);
});

test('the ID is matched however it is written', () => {
  // `#12` off a ticket, `12` off a ref: the same issue, and a verb that finds it
  // one way and not the other is a verb that deletes nothing when it matters.
  for (const id of ['#12', '12']) {
    assert.equal(findIssueCheckouts(gh(), { worktrees, branches }, id)[0]?.branch, 'feat/12-thing');
  }
});

test('a branch whose worktree is gone is found with a null path', () => {
  // The state `resume` exists to repair: the work is not lost, the checkout is.
  assert.deepEqual(findIssueCheckouts(gh(), { worktrees, branches }, '#13'), [
    { branch: 'fix/13-other', path: null },
  ]);
});

test('the worktree entry wins over the bare ref for the same branch', () => {
  const found = findIssueCheckouts(gh(), { worktrees, branches: ['feat/12-thing'] }, '#12');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '/r/.worktrees/feat-12-thing', 'a mounted branch must keep its path');
});

test('two branches for one ticket are both reported, sorted', () => {
  const found = findIssueCheckouts(
    gh(),
    { worktrees: [], branches: ['fix/12-second-attempt', 'feat/12-thing'] },
    '#12',
  );
  assert.deepEqual(found.map((f) => f.branch), ['feat/12-thing', 'fix/12-second-attempt']);
});

test('nothing matches a ticket with no branch, and a number is not an ID', () => {
  assert.deepEqual(findIssueCheckouts(gh(), { worktrees, branches }, '#99'), []);
  // `feat/12-fix-500-error` is issue 12, not 500 — the anchoring rule in
  // issueIdFromBranch, asserted from the side that would delete a branch.
  assert.deepEqual(
    findIssueCheckouts(gh(), { worktrees: [], branches: ['feat/12-fix-500-error'] }, '#500'),
    [],
  );
});

test('YouTrack IDs are found by their own syntax', () => {
  const config = yt();
  const found = findIssueCheckouts(
    config,
    { worktrees: [], branches: ['main', 'feat/ABC-22-thing'] },
    'ABC-22',
  );
  assert.deepEqual(found, [{ branch: 'feat/ABC-22-thing', path: null }]);
});

// --- what the ticket is told ---------------------------------------------------

test('the comment carries the reason and an inventory of what went', () => {
  const out = abandonComment({
    reason: 'superseded by #31',
    branch: 'feat/12-thing',
    commits: 3,
    changes: 2,
  });
  assert.match(out, /^Abandoned — superseded by #31/);
  assert.match(out, /Dropped `feat\/12-thing`/);
  assert.match(out, /3 commits not on the base branch and 2 uncommitted changes/);
});

test('nothing dropped is said plainly rather than as an empty list', () => {
  assert.match(
    abandonComment({ reason: 'wrong approach', branch: 'feat/12-thing' }),
    /Dropped `feat\/12-thing`\.$/,
  );
  assert.match(
    abandonComment({ reason: 'never started', branch: null }),
    /No local branch was found/,
  );
});

// --- whether a resumed ticket is behind its branch -----------------------------

const ladder = { states: { ladder: ['Backlog', 'In Progress', 'In Review', 'Done'] } };

test('a ticket behind the branch is moved forward, and one ahead is left alone', () => {
  assert.equal(stateGap(gh(ladder), 'Backlog').move, true);
  assert.equal(stateGap(gh(ladder), 'In Progress').move, false);
  assert.equal(stateGap(gh(ladder), 'In Review').move, false);
  assert.match(stateGap(gh(ladder), 'In Review').why, /already at In Review/);
});

test('an off-ladder or unreadable ticket is never moved', () => {
  // The same rule the reconciler applies: a ticket parked in Blocked was put
  // there on purpose, and "I could not read it" is not evidence of anything.
  assert.deepEqual(stateGap(gh(ladder), 'Blocked'), {
    move: false,
    why: 'Blocked is off the ladder — left alone',
  });
  assert.equal(stateGap(gh(ladder), 'unknown').move, false);
  assert.equal(stateGap(gh(ladder), null).move, false);
});

// --- the destructive half, against a real repository --------------------------
//
// The scaffold and the stub live in ./ghstub.mjs: `standup` drives the same
// shapes, and two copies of a fake are two fakes that will disagree.

test('commitsAhead counts what deleting the branch would lose', async () => {
  const { repo, vcs } = await scaffold();

  const ahead = await vcs.commitsAhead(repo, { base: 'main', branch: 'feat/12-thing' });
  assert.ok(ahead.ok, ahead.error);
  assert.equal(ahead.count, 1);
  assert.match(ahead.subjects[0], /feat\(x\): half of it \(#12\)/);

  const none = await vcs.commitsAhead(repo, { base: 'main', branch: 'fix/13-other' });
  assert.deepEqual([none.ok, none.count], [true, 0]);

  // A base that is not there is reported, not thrown: `abandon` still has to be
  // able to say what it could not check.
  const missing = await vcs.commitsAhead(repo, { base: 'develop', branch: 'fix/13-other' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /develop/);
});

test('listBranches names every branch, unadorned', async () => {
  const { repo, vcs } = await scaffold();
  assert.deepEqual(await vcs.listBranches(repo), ['feat/12-thing', 'fix/13-other', 'main']);
});

test('an unmerged branch survives a teardown that was not forced', async () => {
  const { repo, wt, vcs } = await scaffold();

  const out = await vcs.cleanupWork({
    repoDir: repo,
    worktreePath: wt,
    branch: 'feat/12-thing',
    worktreeRoot: join(repo, '.worktrees'),
  });

  assert.ok(out.ok);
  assert.equal(out.branchDeleted, false, 'git refused, and that refusal is the guarantee');
  assert.ok((await vcs.listBranches(repo)).includes('feat/12-thing'));
  assert.equal(existsSync(wt), false, 'the worktree still comes down; the commits are what is kept');
});

test('--force is what deletes an unmerged branch, and it deletes only that one', async () => {
  const { repo, wt, vcs } = await scaffold();

  const out = await vcs.cleanupWork({
    repoDir: repo,
    worktreePath: wt,
    branch: 'feat/12-thing',
    worktreeRoot: join(repo, '.worktrees'),
    force: true,
  });

  assert.ok(out.ok);
  assert.equal(out.branchDeleted, true);
  assert.deepEqual(await vcs.listBranches(repo), ['fix/13-other', 'main']);
});

test('branch mode: the checkout is moved off the branch before it is deleted', async () => {
  // Without the switch, git refuses to delete a branch that is checked out, and
  // the verb reports a failure the caller could have removed.
  const { repo, vcs } = await scaffold();
  await git(repo, 'switch', 'fix/13-other');

  const out = await vcs.cleanupWork({
    repoDir: repo,
    worktreePath: null,
    branch: 'fix/13-other',
    force: true,
    switchTo: 'main',
  });

  assert.ok(out.ok);
  assert.equal(out.branchDeleted, true);
  assert.equal(await git(repo, 'branch', '--show-current'), 'main');
});

test('a worktree the session is not standing in comes down with its untracked files', async () => {
  const { repo, wt, vcs } = await scaffold();
  writeFileSync(join(wt, 'scratch.txt'), 'scratch\n');

  const dirty = await vcs.isClean(wt);
  assert.equal(dirty.clean, false, 'an untracked file is work too — abandon must see it');

  const out = await vcs.cleanupWork({
    repoDir: repo,
    worktreePath: wt,
    branch: 'feat/12-thing',
    worktreeRoot: join(repo, '.worktrees'),
    force: true,
  });
  assert.ok(out.ok);
  assert.equal(existsSync(wt), false);
});

test('resume re-mounts an existing branch and never creates one', async () => {
  const { repo, wt, vcs } = await scaffold();
  await git(repo, 'worktree', 'remove', '--force', wt);
  assert.equal(existsSync(wt), false);

  const back = await vcs.startWork({
    dir: repo,
    branch: 'feat/12-thing',
    base: 'main',
    mode: 'worktree',
    worktreePath: wt,
  });

  assert.ok(back.ok, back.error);
  assert.equal(back.created, false, 'the branch was there — resume must never create one');
  assert.equal(back.dir, wt);
  assert.equal(await git(wt, 'branch', '--show-current'), 'feat/12-thing');
  // And the commit the last session made is still on it.
  assert.equal((await vcs.commitsAhead(repo, { base: 'main', branch: 'feat/12-thing' })).count, 1);
});

// --- the whole verb, against a stub GitHub CLI ---------------------------------
//
// A dry run proves nothing about a write path (CLAUDE.md), and neither does a
// unit test of the pieces: what has to hold for `abandon` is an *ordering* —
// the tracker is written first, and the branch only goes once that succeeded.
// So the command is run as the skills run it, with `gh` replaced by a script
// that records every call and can be told to fail. This is not the real API,
// and it does not pretend to be; it is the only way to assert "a refusal wrote
// nothing" and "a rejected write deleted nothing" at all.

test('abandon refuses work in progress, and writes nothing at all', async () => {
  const { repo, wt, dev, read, vcs } = await withStubGh();
  writeFileSync(join(wt, 'half-done.txt'), 'in progress\n');

  const r = await dev(['abandon', '#12', 'changed my mind']);

  assert.notEqual(r.code, 0, 'a refusal must not exit 0');
  assert.match(r.stderr, /still holds work/);
  assert.match(r.stderr, /half-done\.txt/, 'name what would be lost');
  assert.match(r.stderr, /half of it \(#12\)/, 'the commit too, not only the dirty file');
  assert.match(r.stderr, /--force/, 'and the flag that would discard it');

  // The whole point: nothing was written before the check.
  const log = read('log');
  assert.doesNotMatch(log, /issue edit/, 'the tracker must be untouched');
  assert.equal(read('comment'), '', 'and no comment posted');
  assert.ok((await vcs.listBranches(repo)).includes('feat/12-thing'));
  assert.equal(existsSync(wt), true, 'the worktree is exactly as it was found');
});

test('a tracker that rejects the write leaves the branch alone', async () => {
  // The ordering rule, from the only side that can prove it: if the ticket
  // could not be moved, the work must still be there to try again with.
  const { repo, wt, dev, vcs } = await withStubGh();

  const r = await dev(['abandon', '#12', 'no longer needed', '--force'], { GH_FAIL_EDIT: '1' });

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Nothing was deleted/);
  assert.ok((await vcs.listBranches(repo)).includes('feat/12-thing'));
  assert.equal(existsSync(wt), true);
});

test('abandon --force records the reason, walks the ticket back, then tears down', async () => {
  const { repo, wt, dev, read, vcs } = await withStubGh();
  writeFileSync(join(wt, 'half-done.txt'), 'in progress\n');

  const r = await dev(['abandon', '#12', 'superseded by #31', '--force']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /state: +Backlog/, 'the state read back, not the one requested');
  assert.match(r.stdout, /discard: +1 uncommitted change, 1 commit not on main/);
  assert.match(r.stdout, /branch feat\/12-thing deleted/);

  const comment = read('comment');
  assert.match(comment, /Abandoned — superseded by #31/);
  assert.match(comment, /1 commit not on the base branch and 1 uncommitted change/);

  assert.equal(existsSync(wt), false, 'the worktree is gone');
  assert.deepEqual(await vcs.listBranches(repo), ['fix/13-other', 'main']);
});

test('abandon still records a ticket whose branch nobody kept', async () => {
  const { repo, dev, read, vcs } = await withStubGh();
  await git(repo, 'worktree', 'remove', '--force', join(repo, '.worktrees', 'feat-12-thing'));
  await git(repo, 'branch', '-D', 'feat/12-thing');

  const r = await dev(['abandon', '#12', 'done elsewhere']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /branch: +none found/);
  assert.match(read('comment'), /No local branch was found/);
  assert.deepEqual(await vcs.listBranches(repo), ['fix/13-other', 'main']);
});

test('resume puts a missing worktree back and catches the ticket up', async () => {
  const { repo, wt, dev, read } = await withStubGh({ labels: '' }); // no label = Backlog
  await git(repo, 'worktree', 'remove', '--force', wt);
  writeFileSync(join(repo, 'untouched.txt'), 'the main checkout must not be disturbed\n');

  const r = await dev(['resume', '#12']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mount: +worktree put back/);
  assert.match(r.stdout, /commits: +1 not on main/);
  assert.match(r.stdout, /half of it \(#12\)/, 'say what the last session had already done');
  assert.match(r.stdout, /state: +In Progress/, 'a ticket behind its branch is caught up');
  assert.match(r.stdout, /\ncd .*feat-12-thing\n?$/, 'the working directory is the last line');
  assert.match(read('log'), /issue edit .*--add-label status: in progress/);
  assert.equal(existsSync(wt), true);
});

test('resume reports the uncommitted work rather than a count of it', async () => {
  const { wt, dev } = await withStubGh();
  writeFileSync(join(wt, 'half-done.txt'), 'in progress\n');
  await git(wt, 'add', 'half-done.txt');
  writeFileSync(join(wt, 'scratch.md'), 'notes\n');

  const r = await dev(['resume', '#12']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /changes: +2 uncommitted/);
  assert.match(r.stdout, /A {2}half-done\.txt/, 'staged, with its status');
  assert.match(r.stdout, /\?\? scratch\.md/, 'and untracked');
  assert.match(r.stdout, /state: +In Progress — already at In Progress/, 'nothing to catch up');
});

test('resume refuses a ticket that was never started here', async () => {
  const { dev, read } = await withStubGh();
  const r = await dev(['resume', '#99']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /dev\.mjs start #99/, 'point at the command that would create it');
  assert.doesNotMatch(read('log'), /issue edit/);
});

test('--print reports and repairs nothing', async () => {
  const { repo, wt, dev, read } = await withStubGh({ labels: '' });
  await git(repo, 'worktree', 'remove', '--force', wt);

  const r = await dev(['resume', '#12', '--print']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mount: +missing/);
  assert.match(r.stdout, /--print: not moved/);
  assert.equal(existsSync(wt), false, 'nothing was created');
  assert.doesNotMatch(read('log'), /issue edit/, 'and nothing was written');
});
