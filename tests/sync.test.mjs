import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  byIssueNumber,
  commitObservations,
  cutoffFrom,
  decide,
  extractIssueIds,
  LOG_SEP,
  parseSince,
  renderComment,
  slugFromRemoteUrl,
  strongestEvidence,
} from '../lib/sync.mjs';

/** One `git log --format=%H<sep>%s` line. */
const logLine = (sha, subject) => `${sha}${LOG_SEP}${subject}`;

const DONE = { syntax: null, rank: 2, state: 'Done', urlFor: (sha) => `https://gh/c/${sha}` };
const gh = { regex: /#\d+/g, sample: '#42' };

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

// --- commits that belong to no PR --------------------------------------------

test('commitObservations reads an issue ID out of a landed commit subject', () => {
  const log = [
    logLine('aaa111', 'fix(router): 500 on nested slug (ABC-12)'),
    logLine('bbb222', 'feat(api): pagination (ABC-13)'),
  ].join('\n');

  assert.deepEqual(commitObservations(log, { ...DONE, syntax: 'ABC' }), [
    { id: 'ABC-12', rank: 2, state: 'Done', url: 'https://gh/c/aaa111' },
    { id: 'ABC-13', rank: 2, state: 'Done', url: 'https://gh/c/bbb222' },
  ]);
});

test('commitObservations skips a subject that names no issue', () => {
  // The same convention-bounded coverage the PR pass has: a commit that names
  // nothing is invisible, and that is the finding rather than a bug.
  const log = [
    logLine('aaa111', 'chore(no-ticket): tidy up the router'),
    logLine('bbb222', 'fix(sync): a real one (ABC-1)'),
  ].join('\n');

  assert.deepEqual(
    commitObservations(log, { ...DONE, syntax: 'ABC' }).map((o) => o.id),
    ['ABC-1'],
  );
});

test('commitObservations tolerates the shapes a git log actually has', () => {
  // A trailing newline, an empty log, and a subject carrying the separator's
  // near neighbours — tabs and spaces — which is why the format uses \x1f.
  assert.deepEqual(commitObservations('', { ...DONE, syntax: 'ABC' }), []);
  assert.deepEqual(commitObservations('  \n\n', { ...DONE, syntax: 'ABC' }), []);
  assert.deepEqual(
    commitObservations(`${logLine('aaa111', 'fix: a\tsubject with (ABC-9)')}\n`, {
      ...DONE,
      syntax: 'ABC',
    }).map((o) => o.id),
    ['ABC-9'],
  );
});

test('commitObservations reads GitHub IDs with the provider syntax', () => {
  assert.deepEqual(
    commitObservations(logLine('aaa111', 'feat(adr): guard records (#38)'), {
      ...DONE,
      syntax: gh,
    }),
    [{ id: '#38', rank: 2, state: 'Done', url: 'https://gh/c/aaa111' }],
  );
});

test('an issue whose only evidence is a landed commit still reaches done', () => {
  // #19: `sync` took its evidence exclusively from pull requests, so a project
  // on `delivery.mode: direct` — which never opens one — had every ticket
  // stranded while the run reported "everything is in sync".
  const observations = [
    // ...and this is what the PR passes contribute for it: nothing at all.
    ...commitObservations(logLine('5b79ec7', 'fix(hook): brace only multi-word values (#1)'), {
      ...DONE,
      syntax: gh,
    }),
  ];
  const evidence = strongestEvidence(observations);
  const ev = evidence.get('#1');
  assert.ok(ev, 'the commit is the only thing that names #1');

  const first = decide({ current: 'In Progress', currentRank: 1, targetRank: ev.rank, url: ev.url });
  assert.equal(first.action, 'move');
  assert.equal(first.why, 'https://gh/c/5b79ec7');

  // Forward-only and idempotent on the second run, exactly as PR evidence is —
  // which is the whole reason this evidence folds into `decide` rather than
  // growing a path of its own.
  assert.equal(
    decide({ current: 'Done', currentRank: 3, targetRank: ev.rank, url: ev.url }).action,
    'ahead',
  );
  assert.equal(
    decide({ current: "Won't Fix", currentRank: -1, targetRank: ev.rank, url: ev.url }).action,
    'off-ladder',
  );
});

test('a merged PR outranks nothing and outlasts a commit saying the same thing', () => {
  // Same rank, so `strongestEvidence` keeps the first — and the commit pass
  // runs last precisely so the PR's URL is the one a reader gets.
  const evidence = strongestEvidence([
    { id: '#1', rank: 2, state: 'Done', url: 'https://gh/pr/4' },
    ...commitObservations(logLine('5b79ec7', 'fix: landed (#1)'), { ...DONE, syntax: gh }),
  ]);
  assert.equal(evidence.get('#1').url, 'https://gh/pr/4');
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

// --- right state, stale representation ---------------------------------------

test('decide repairs a ticket in the right state that says otherwise', () => {
  // The strand: GitHub closes the issue itself at merge, so it reads Done while
  // still carrying `in review`. `ahead` is the correct answer about its state
  // and the reason nothing was ever repaired.
  const d = decide({ current: 'Done', currentRank: 3, targetRank: 3, stale: 'labelled "in review"' });
  assert.equal(d.action, 'repair');
  assert.equal(d.why, 'labelled "in review"', 'the adapter owns the wording; decide only passes it on');
});

test('decide repairs a ticket that is past the target too', () => {
  assert.equal(
    decide({ current: 'Done', currentRank: 3, targetRank: 1, stale: 'stale' }).action,
    'repair',
  );
});

test('a ticket that is behind moves rather than being repaired', () => {
  // `move` rewrites the representation on its way past, so repairing here would
  // be a second write saying the same thing.
  assert.equal(
    decide({ current: 'Open', currentRank: 0, targetRank: 2, url: 'u', stale: 'stale' }).action,
    'move',
  );
});

test('an off-ladder or unreadable ticket is never repaired', () => {
  // Both were parked or lost deliberately; drift is not a reason to touch them.
  assert.equal(decide({ current: "Won't Fix", currentRank: -1, targetRank: 2, stale: 'x' }).action, 'off-ladder');
  assert.equal(decide({ current: 'unknown', currentRank: -1, targetRank: 2, stale: 'x' }).action, 'unreadable');
});

test('a backend with no second copy of its state never sees the repair branch', () => {
  // `checkRepresentation` answers null there, and null must read as "in sync".
  assert.equal(decide({ current: 'Done', currentRank: 3, targetRank: 3, stale: null }).action, 'ahead');
  assert.equal(decide({ current: 'Done', currentRank: 3, targetRank: 3 }).action, 'ahead');
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
