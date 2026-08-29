/**
 * The standup report: what merged, what is in flight, what has stopped, what is next.
 *
 * Nearly all of it is pure, and that is deliberate — a report whose output
 * depends on the wall clock cannot be asserted, so the clock is a parameter
 * here exactly as it is in `lib/notes.mjs`. The one thing that cannot be
 * asserted purely is that the command wires the pieces together, so the last
 * section runs the real CLI against the shared `gh` stub.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, deepMerge } from '../lib/config.mjs';
import {
  ageDays,
  classify,
  describeStandup,
  humanAge,
  inFlight,
  mergedSince,
  OPEN_SHOWN,
  pickNext,
  WAITING,
} from '../lib/standup.mjs';
import { PR_UNKNOWN } from '../lib/status.mjs';
import { git, withStubGh } from './ghstub.mjs';

const config = deepMerge(DEFAULTS, {
  provider: 'github',
  github: { repo: 'o/r', labels: { 'In Progress': 'a', 'In Review': 'b', Done: 'c' } },
  states: {
    ladder: ['Backlog', 'In Progress', 'In Review', 'Done'],
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
  },
});

const NOW = new Date('2026-08-27T09:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// --- ages ---------------------------------------------------------------------

test('an age is coarse, and a branch with no commits has none', () => {
  assert.equal(humanAge(daysAgo(0), NOW), 'today');
  assert.equal(humanAge(daysAgo(3), NOW), '3d');
  assert.equal(humanAge(daysAgo(20), NOW), '2w');
  assert.equal(humanAge(daysAgo(90), NOW), '3mo');
  // Null, not "0 days": nothing to date is not the same as dated now, and
  // reporting it as today would put it top of a staleness list it is not on.
  assert.equal(ageDays(null, NOW), null);
  assert.equal(humanAge(null, NOW), '-');
  assert.equal(humanAge('not a date', NOW), '-');
});

test('a clock skewed into the future does not report a negative age', () => {
  assert.equal(ageDays(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW), 0);
});

// --- what merged ---------------------------------------------------------------

const prs = [
  { number: 27, state: 'MERGED', title: 'feat: the thing (#25)', mergedAt: daysAgo(0), headRefName: '25-thing' },
  { number: 26, state: 'MERGED', title: 'older', mergedAt: daysAgo(9), headRefName: '24-old' },
  { number: 28, state: 'OPEN', title: 'in review', mergedAt: null, headRefName: '19-open' },
  { number: 29, state: 'CLOSED', title: 'dropped', mergedAt: null, headRefName: '18-closed' },
];

test('merged since takes only merged PRs inside the window, newest first', () => {
  const cutoff = daysAgo(1);
  assert.deepEqual(mergedSince(prs, { cutoff }).map((p) => p.number), [27]);
  assert.deepEqual(mergedSince(prs, { cutoff: daysAgo(30) }).map((p) => p.number), [27, 26]);
  assert.deepEqual(mergedSince([], { cutoff }), []);
});

// --- what counts as in flight ---------------------------------------------------

test('the base branch is not work in flight, but a branch with no ticket is', () => {
  const rows = [
    { branch: 'main' },
    { branch: 'feat/12-thing' },
    { branch: 'someones-experiment' },
  ];
  assert.deepEqual(inFlight(rows, { base: 'main' }).map((r) => r.branch), [
    'feat/12-thing',
    'someones-experiment',
  ]);
});

// --- what each row needs ---------------------------------------------------------

const row = (patch) => ({ issue: null, pr: null, dirty: 0, commits: 0, config, ...patch });

test('a merged PR whose ticket never moved is the cheapest thing to fix', () => {
  const r = classify(row({
    issue: { id: '#12', state: 'In Review' },
    pr: { number: 27, state: 'MERGED' },
  }));
  assert.equal(r.priority, 0);
  assert.match(r.advice, /dev\.mjs sync --apply/);
});

test('a merged PR whose ticket is done is not work at all', () => {
  const r = classify(row({ issue: { id: '#12', state: 'Done' }, pr: { number: 27, state: 'MERGED' } }));
  assert.equal(r.priority, WAITING, 'never offered as next');
});

test('an open PR is waiting on somebody else and is never next', () => {
  const r = classify(row({ issue: { id: '#12', state: 'In Review' }, pr: { number: 27, state: 'OPEN' } }));
  assert.equal(r.priority, WAITING);
  assert.match(r.advice, /waiting on review/);
});

test('a PR closed unmerged is a decision, and names both ways out', () => {
  const r = classify(row({ issue: { id: '#12', state: 'In Progress' }, pr: { number: 27, state: 'CLOSED' } }));
  assert.equal(r.priority, 1);
  assert.match(r.advice, /reopen/);
  assert.match(r.advice, /dev\.mjs abandon #12/);
});

test('uncommitted work beats committed work, and both beat an untouched branch', () => {
  const dirty = classify(row({ issue: { id: '#12', state: 'In Progress' }, dirty: 3 }));
  const ahead = classify(row({ issue: { id: '#12', state: 'In Progress' }, commits: 2 }));
  const idle = classify(row({ issue: { id: '#12', state: 'In Progress' } }));

  assert.ok(dirty.priority < ahead.priority, 'finish what is open before starting to land');
  assert.ok(ahead.priority < idle.priority);
  assert.match(dirty.advice, /3 uncommitted changes/);
  assert.match(ahead.advice, /dev\.mjs land/);
  assert.match(idle.advice, /dev\.mjs resume #12/);
});

test('a ticket behind its branch is reported as such', () => {
  const r = classify(row({ issue: { id: '#12', state: 'Backlog' } }));
  assert.match(r.advice, /behind the branch/);
  assert.match(r.advice, /dev\.mjs resume #12/);
});

test('a state the ladder does not have is never treated as behind', () => {
  // A ticket parked in Blocked was put there on purpose — the same rule the
  // reconciler applies, reached from the other side.
  const r = classify(row({ issue: { id: '#12', state: 'Blocked' } }));
  assert.equal(r.priority, 5);
  assert.doesNotMatch(r.advice, /behind/);
});

// --- what to pick up ------------------------------------------------------------

test('next is the highest-priority row, and ties break by issue number', () => {
  const rows = [
    { issue: { id: '#20', state: 'In Progress' }, pr: null, dirty: 2, commits: 0, branch: 'b20' },
    { issue: { id: '#9', state: 'In Progress' }, pr: null, dirty: 1, commits: 0, branch: 'b9' },
    { issue: { id: '#3', state: 'In Review' }, pr: { number: 1, state: 'OPEN' }, dirty: 0, branch: 'b3' },
  ];
  assert.equal(pickNext(rows, config).row.issue.id, '#9', '#9 sorts before #20, not lexically');
});

test('nothing is next when everything is with someone else', () => {
  const rows = [{ issue: { id: '#3', state: 'In Review' }, pr: { number: 1, state: 'OPEN' }, dirty: 0 }];
  assert.equal(pickNext(rows, config), null, 'inventing a task would make the report untrustworthy');
  assert.equal(pickNext([], config), null);
});

// --- the report -----------------------------------------------------------------

const facts = (patch = {}) => ({
  rows: [],
  merged: [],
  config,
  since: '1d',
  cutoff: daysAgo(1),
  staleAfter: 7,
  // A tracker that was read and found nothing — the ordinary case. The tests
  // that care about an unread board say so by passing `open: null` or an error.
  open: { rows: [], truncated: false, error: null },
  now: NOW,
  ...patch,
});

/** An open-issue row as `provider.listOpen` returns one. */
const openRow = (n, state = 'Backlog', title = `issue ${n}`) => ({
  id: `#${n}`,
  title,
  state,
  url: `https://github.com/o/r/issues/${n}`,
});

test('every section says it is empty rather than vanishing', () => {
  const out = describeStandup(facts()).join('\n');
  assert.match(out, /nothing merged in the window/);
  assert.match(out, /no ticket branches/);
  assert.match(out, /nothing has been sitting that long/);
  assert.match(out, /no open issues/);
  assert.match(out, /nothing in flight and nothing open/);
});

test('the same facts print the same bytes', () => {
  const f = facts({
    rows: [{ issue: { id: '#12', state: 'In Progress' }, branch: 'feat/12-x', dirty: 1, commits: 2, lastCommit: daysAgo(2), pr: null }],
    merged: [{ number: 27, title: 'feat: the thing', mergedAt: daysAgo(0), issue: { id: '#25', state: 'Done' } }],
  });
  assert.equal(describeStandup(f).join('\n'), describeStandup(f).join('\n'));
});

test('a merged PR whose ticket was never reconciled is called out in the report', () => {
  const out = describeStandup(facts({
    merged: [{ number: 27, title: 'feat: the thing', mergedAt: daysAgo(0), issue: { id: '#25', state: 'In Review' } }],
  })).join('\n');
  assert.match(out, /#27 {2}feat: the thing/);
  assert.match(out, /merged, but the ticket has not been reconciled — dev\.mjs sync --apply/);
});

test('stale is a measurement, and the threshold is always printed', () => {
  const out = describeStandup(facts({
    staleAfter: 7,
    rows: [
      { issue: { id: '#19', state: 'In Progress' }, branch: 'feat/19-old', dirty: 0, commits: 1, lastCommit: daysAgo(21), pr: null },
      { issue: { id: '#12', state: 'In Progress' }, branch: 'feat/12-new', dirty: 0, commits: 1, lastCommit: daysAgo(1), pr: null },
    ],
  })).join('\n');

  assert.match(out, /stale — no commit for 7d/);
  assert.match(out, /#19 {6}3w/);
  assert.doesNotMatch(out, /#12 {6}1d {5}\d+ commit/, 'a branch touched yesterday is not stale');
});

// --- the board itself (#35) -------------------------------------------------------

test('open issues nothing has branched for get a section of their own', () => {
  const out = describeStandup(facts({
    open: { rows: [openRow(14), openRow(33, 'In Progress', 'cost of a workflow change')], truncated: false, error: null },
  })).join('\n');

  assert.match(out, /open in the tracker/);
  // Newest first: a backlog is read from the top, unlike a worklist.
  assert.match(out, /#33 +In Progress +cost of a workflow change/);
  assert.match(out, /#14 +Backlog/);
  assert.ok(out.indexOf('#33') < out.indexOf('#14'), 'newest first');
});

test('an issue already in flight is not listed a second time', () => {
  const out = describeStandup(facts({
    rows: [{ issue: { id: '#14', state: 'In Progress' }, branch: 'fix/14-x', dirty: 0, commits: 3, lastCommit: daysAgo(0), pr: null }],
    merged: [{ number: 27, title: 'feat: done', mergedAt: daysAgo(0), issue: { id: '#25', state: 'Done' } }],
    open: { rows: [openRow(14), openRow(25)], truncated: false, error: null },
  })).join('\n');

  const section = out.slice(out.indexOf('open in the tracker'), out.indexOf('\nnext'));
  assert.doesNotMatch(section, /#14/, 'it is in the in-flight table above');
  assert.doesNotMatch(section, /#25/, 'it is in the merged section above');
  assert.match(section, /nothing open that is not already in flight above/);
});

test('an unreachable tracker says so instead of reading as a clear board', () => {
  const out = describeStandup(facts({
    open: { rows: [], truncated: false, error: 'gh is not authenticated — run: gh auth login' },
  })).join('\n');

  assert.match(out, /could not read the tracker: gh is not authenticated/);
  // The defect in #35: a claim about the whole board from a command that never
  // read it. With the board unread the sentence must be scoped to what was.
  assert.match(out, /the board is unread/);
  assert.doesNotMatch(out, /the board is clear/);
});

test('a board that was never read is not a board that is empty', () => {
  const out = describeStandup(facts({ open: null })).join('\n');
  assert.match(out, /\(not read\)/);
  assert.match(out, /the board is unread/);
  assert.doesNotMatch(out, /no open issues/);
});

test('the open list is capped, and says how many it did not print', () => {
  const rows = Array.from({ length: OPEN_SHOWN + 3 }, (_, i) => openRow(100 + i));
  const out = describeStandup(facts({ open: { rows, truncated: false, error: null } })).join('\n');

  const section = out.slice(out.indexOf('open in the tracker'), out.indexOf('\nnext'));
  assert.equal(section.split('\n').filter((l) => /^ {2}#\d/.test(l)).length, OPEN_SHOWN);
  assert.match(section, /… and 3 more open — see the tracker/);
});

test('a truncated read counts open-endedly rather than under-reporting', () => {
  const rows = Array.from({ length: OPEN_SHOWN + 1 }, (_, i) => openRow(100 + i));
  const out = describeStandup(facts({ open: { rows, truncated: true, error: null } })).join('\n');
  // 1 hidden that we know of, and an unknown number we never fetched. Printing
  // a bare "1 more" would be the same over-claim in miniature.
  assert.match(out, /… and 1\+ more open/);
});

test('next points at the board when nothing in flight is yours, and never picks from it', () => {
  const out = describeStandup(facts({
    rows: [{ issue: { id: '#3', state: 'In Review' }, pr: { number: 1, state: 'OPEN' }, dirty: 0, branch: 'b3' }],
    open: { rows: [openRow(41), openRow(42)], truncated: false, error: null },
  })).join('\n');

  const next = out.slice(out.indexOf('\nnext'));
  assert.match(next, /2 open above, unstarted: dev\.mjs start <ISSUE-ID>/);
  // Ranking stays in-flight-only: starting something is a decision, and the
  // section above is where it gets made.
  assert.doesNotMatch(next, /#41|#42/);
});

test('an unreadable PR state is reported once, not as "no PR"', () => {
  const out = describeStandup(facts({
    rows: [{ issue: { id: '#12', state: 'In Progress' }, branch: 'feat/12-x', dirty: 0, commits: 0, lastCommit: daysAgo(1), pr: PR_UNKNOWN }],
    prUnknown: true,
  })).join('\n');
  assert.match(out, /PR state unavailable/);
});

// --- the command ------------------------------------------------------------------

test('standup reports the board, and writes nothing', async () => {
  const { repo, wt, dev, read } = await withStubGh({
    prs: [
      {
        number: 27,
        state: 'MERGED',
        title: 'feat: something that landed (#13)',
        url: 'https://github.com/o/r/pull/27',
        headRefName: 'fix/13-other',
        mergedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  await git(repo, 'commit', '--allow-empty', '-m', 'unrelated');
  writeFileSync(join(wt, 'wip.txt'), 'half done\n');

  const r = await dev(['standup', '--since', '7d']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /merged since/);
  assert.match(r.stdout, /#27 {2}feat: something that landed/);
  assert.match(r.stdout, /in flight/);
  assert.match(r.stdout, /#12 {6}In Progress/, 'the ticket state came from the tracker');
  assert.match(r.stdout, /1 dirty/);
  assert.match(r.stdout, /next\n {2}#12 — 1 uncommitted change/);
  assert.doesNotMatch(r.stdout, /main/, 'the base branch is not work in flight');

  // #35: an issue with no branch and no PR contributes no ID to any other read
  // here, so this section is the only thing that can see it at all.
  assert.match(r.stdout, /open in the tracker\n {2}#41 +Backlog +nobody has started this/);
  const board = r.stdout.slice(r.stdout.indexOf('open in the tracker'), r.stdout.indexOf('\nnext'));
  assert.doesNotMatch(board, /#12/, '#12 is in the in-flight table above');

  // A report writes nothing, ever.
  const log = read('log');
  assert.doesNotMatch(log, /issue edit/);
  assert.doesNotMatch(log, /issue comment/);
});

test('standup runs without the GitHub CLI and says which half is missing', async () => {
  const { dev } = await withStubGh();
  const r = await dev(['standup'], { PATH: '/nonexistent' });

  assert.equal(r.code, 0, 'a missing gh is not a reason to refuse to say what is checked out');
  assert.match(r.stdout, /in flight/);
  assert.match(r.stdout, /PR state unavailable/);

  // The board degrades the same way, and must not read as an empty one: an
  // unread tracker and a clear board are the same picture otherwise (#35).
  assert.match(r.stdout, /could not read the tracker/);
  assert.doesNotMatch(r.stdout, /no open issues/);
  assert.match(r.stdout, /the board is unread/);
});
