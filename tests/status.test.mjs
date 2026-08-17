/**
 * The status report's decisions, offline.
 *
 * Everything here is about not lying to someone who is orienting themselves:
 * "no PR yet" and "I could not check" must not look alike, a ticket behind its
 * branch must be called out rather than smoothed over, and the suggested next
 * step must never be something the configuration did not already decide.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deepMerge, DEFAULTS } from '../lib/config.mjs';
import { PR_UNKNOWN, describeBoard, describeCheckout, nextStep } from '../lib/status.mjs';

const config = deepMerge(DEFAULTS, {
  provider: 'github',
  github: { repo: 'acme/api', labels: { 'In Progress': 'a', 'In Review': 'b', Done: 'c' } },
  states: {
    ladder: ['Backlog', 'In Progress', 'In Review', 'Done'],
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
  },
});

const text = (facts) => describeCheckout({ config, ...facts }).lines.join('\n');

test('a branch with no ticket says so instead of guessing an ID', () => {
  const out = text({ branch: 'spike-cache-eviction', issue: null });
  assert.match(out, /issue\s+none/);
  assert.doesNotMatch(out, /#\d/);
});

test('a worktree is marked as one, because which checkout you are in is the trap', () => {
  assert.match(text({ branch: '22-x', isWorktree: true, issue: { id: '#22' } }), /\(worktree\)/);
});

test('a detached HEAD is reported, not rendered as an empty branch', () => {
  assert.match(text({ branch: null, issue: null }), /detached HEAD/);
});

test('"no PR" and "could not check" do not look alike', () => {
  const none = text({ branch: '22-x', issue: { id: '#22', state: 'In Progress' }, pr: null });
  const unknown = text({ branch: '22-x', issue: { id: '#22', state: 'In Progress' }, pr: PR_UNKNOWN });

  assert.match(none, /pr\s+none yet/);
  assert.match(unknown, /could not ask the GitHub CLI/);
  assert.notEqual(none, unknown);
});

test('an open PR reports its number and state', () => {
  const out = text({
    branch: '22-x',
    issue: { id: '#22', state: 'In Review' },
    pr: { number: 23, state: 'OPEN', url: 'https://example.invalid/23' },
  });
  assert.match(out, /pr\s+#23 open/);
});

test('uncommitted work is counted, and the count is not pluralised wrongly', () => {
  assert.match(text({ branch: 'main', issue: null, dirty: 1 }), /1 uncommitted change$/m);
  assert.match(text({ branch: 'main', issue: null, dirty: 4 }), /4 uncommitted changes$/m);
  assert.match(text({ branch: 'main', issue: null, dirty: 0 }), /tree\s+clean/);
});

test('the next step follows the work, not a preference', () => {
  const at = (facts) => nextStep({ config, dirty: 0, pr: null, ...facts });

  assert.equal(at({ issue: null }), null, 'nothing to suggest without a ticket');
  assert.equal(at({ issue: { id: '#22', state: 'In Progress' } }), 'dev.mjs land');
  assert.match(at({ issue: { id: '#22', state: 'In Progress' }, dirty: 2 }), /^commit the work/);
  assert.match(at({ issue: { id: '#22' }, pr: { number: 1, state: 'OPEN' } }), /waiting on review/);
  assert.match(at({ issue: { id: '#22' }, pr: { number: 1, state: 'MERGED' } }), /dev\.mjs sync/);
  assert.match(at({ issue: { id: '#22' }, pr: { number: 1, state: 'CLOSED' } }), /closed unmerged/);
});

test('a ticket behind its own branch is called out, with the command to fix it', () => {
  const next = nextStep({
    config,
    issue: { id: '#22', state: 'Backlog' },
    pr: null,
    dirty: 0,
  });
  assert.match(next, /behind the branch/);
  assert.match(next, /update #22 state start/);
});

test('an unreachable GitHub CLI never becomes a suggestion to act on', () => {
  const next = nextStep({ config, issue: { id: '#22', state: 'In Progress' }, pr: PR_UNKNOWN, dirty: 0 });
  assert.doesNotMatch(next ?? '', /review|merged/);
});

test('the board sorts numerically, and ticketless rows sort last', () => {
  const rows = [
    { path: '/w/none', branch: 'scratch', issue: null, pr: null, dirty: 0 },
    { path: '/w/10', branch: '10-b', issue: { id: '#10', state: 'Done' }, pr: null, dirty: 0 },
    { path: '/w/9', branch: '9-a', issue: { id: '#9', state: 'In Review' }, pr: null, dirty: 0 },
  ];
  const ids = describeBoard(rows)
    .slice(2)
    .map((l) => l.split(/\s+/)[0]);

  assert.deepEqual(ids, ['#9', '#10', '-']);
});

test('the board prints the same bytes for the same rows', () => {
  const rows = [{ path: '/w/9', branch: '9-a', issue: { id: '#9', state: 'Done' }, pr: null, dirty: 0 }];
  assert.equal(describeBoard(rows).join('\n'), describeBoard(rows).join('\n'));
});

test('an empty board says nothing is checked out rather than printing a bare header', () => {
  assert.match(describeBoard([]).join('\n'), /no worktrees/);
});
