import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  byIssueNumber,
  cutoffFrom,
  decide,
  extractIssueIds,
  parseSince,
  renderComment,
  slugFromRemoteUrl,
  strongestEvidence,
} from '../lib/sync.mjs';

// --- --since -----------------------------------------------------------------

test('parseSince understands days, hours and weeks', () => {
  assert.equal(parseSince('30d'), 43_200);
  assert.equal(parseSince('48h'), 2_880);
  assert.equal(parseSince('2w'), 20_160);
  assert.equal(parseSince('7'), 10_080, 'a bare number means days');
});

test('parseSince rejects anything else', () => {
  for (const bad of ['', 'soon', '3m', '-1d', null]) {
    assert.throws(() => parseSince(bad), /--since takes a value/);
  }
});

test('cutoffFrom returns an ISO-8601 instant in the past', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  assert.equal(cutoffFrom(1440, now), '2026-03-14T12:00:00Z');
});

// --- finding issue IDs -------------------------------------------------------

test('extractIssueIds finds ids in a branch name or title', () => {
  assert.deepEqual(extractIssueIds('ABC-398-redirect-301-map', 'ABC'), ['ABC-398']);
  assert.deepEqual(extractIssueIds('fix(router): 500 on nested slug (ABC-12)', 'ABC'), ['ABC-12']);
});

test('extractIssueIds deduplicates and preserves order', () => {
  assert.deepEqual(extractIssueIds('ABC-2 ABC-1 ABC-2', 'ABC'), ['ABC-2', 'ABC-1']);
});

test('extractIssueIds ignores other projects', () => {
  assert.deepEqual(extractIssueIds('XYZ-1 ABC-2', 'ABC'), ['ABC-2']);
});

test('extractIssueIds does not match a partial project prefix', () => {
  // A PR for project AB must not be credited to project ABC, or vice versa.
  assert.deepEqual(extractIssueIds('ABCD-1', 'ABC'), []);
  assert.deepEqual(extractIssueIds('xABC-1', 'ABC'), []);
});

test('extractIssueIds returns nothing when the convention was not followed', () => {
  // This is the documented limit: a PR naming no issue is invisible.
  assert.deepEqual(extractIssueIds('hotfix: tidy up the router', 'ABC'), []);
});

// --- remotes -----------------------------------------------------------------

test('slugFromRemoteUrl handles ssh and https remotes', () => {
  assert.equal(slugFromRemoteUrl('git@github.com:acme/frontend.git'), 'acme/frontend');
  assert.equal(slugFromRemoteUrl('https://github.com/acme/frontend.git'), 'acme/frontend');
  assert.equal(slugFromRemoteUrl('https://github.com/acme/frontend'), 'acme/frontend');
  assert.equal(slugFromRemoteUrl('ssh://git@github.com/acme/frontend.git'), 'acme/frontend');
});

test('slugFromRemoteUrl rejects what is not a forge remote', () => {
  assert.equal(slugFromRemoteUrl(''), null);
  assert.equal(slugFromRemoteUrl(null), null);
  assert.equal(slugFromRemoteUrl('/srv/git/bare-repo'), null);
});

// --- evidence ----------------------------------------------------------------

test('strongestEvidence prefers a merged PR over an open one', () => {
  const ev = strongestEvidence([
    { id: 'ABC-1', rank: 1, state: 'In Review', url: 'open' },
    { id: 'ABC-1', rank: 2, state: 'Done', url: 'merged' },
  ]);
  assert.deepEqual(ev.get('ABC-1'), { rank: 2, state: 'Done', url: 'merged' });
});

test('strongestEvidence is order-independent', () => {
  const ev = strongestEvidence([
    { id: 'ABC-1', rank: 2, state: 'Done', url: 'merged' },
    { id: 'ABC-1', rank: 1, state: 'In Review', url: 'open' },
  ]);
  assert.equal(ev.get('ABC-1').state, 'Done');
});

test('strongestEvidence keeps issues apart and skips idless rows', () => {
  const ev = strongestEvidence([
    { id: 'ABC-1', rank: 1, state: 'In Review', url: 'a' },
    { id: 'ABC-2', rank: 2, state: 'Done', url: 'b' },
    { id: null, rank: 2, state: 'Done', url: 'c' },
  ]);
  assert.equal(ev.size, 2);
});

// --- the safety rules --------------------------------------------------------

test('decide moves a ticket that has fallen behind', () => {
  assert.equal(decide({ current: 'Open', currentRank: 0, targetRank: 2, url: 'u' }).action, 'move');
});

test('decide never moves a ticket backwards', () => {
  // Idempotence: this is what makes running sync twice a no-op, and what makes
  // it safe from a hook or a cron.
  assert.equal(decide({ current: 'Done', currentRank: 3, targetRank: 1 }).action, 'ahead');
  assert.equal(decide({ current: 'Done', currentRank: 3, targetRank: 3 }).action, 'ahead');
});

test('decide leaves off-ladder tickets alone', () => {
  // Blocked / Won't Fix were set deliberately; the reconciler must not undo it.
  const d = decide({ current: "Won't Fix", currentRank: -1, targetRank: 2 });
  assert.equal(d.action, 'off-ladder');
  assert.match(d.why, /left alone/);
});

test('decide skips an issue whose state could not be read', () => {
  assert.equal(decide({ current: 'unknown', currentRank: -1, targetRank: 2 }).action, 'unreadable');
});

// --- comments ----------------------------------------------------------------

test('renderComment fills the template placeholders', () => {
  assert.equal(
    renderComment('PR {url} — {state}', { url: 'https://gh/pr/1', state: 'Done' }),
    'PR https://gh/pr/1 — Done',
  );
});

test('renderComment replaces every occurrence and tolerates a missing template', () => {
  assert.equal(renderComment('{state}/{state}', { state: 'Done' }), 'Done/Done');
  assert.equal(renderComment(undefined, { url: 'u', state: 's' }), '');
});

// --- ordering ----------------------------------------------------------------

test('byIssueNumber sorts numerically, not lexically', () => {
  const ids = ['ABC-10', 'ABC-9', 'ABC-100', 'ABC-1'];
  assert.deepEqual(ids.sort(byIssueNumber), ['ABC-1', 'ABC-9', 'ABC-10', 'ABC-100']);
});
