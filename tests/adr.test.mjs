/**
 * ADR numbering, rendering, superseding and indexing.
 *
 * Two invariants carry the weight, and both are here rather than in the command
 * because both are pure: a number is never reused, and a supersede writes links
 * in both directions. Everything else is formatting, but the formatting is what
 * `hooks/check-adr-immutable.sh` matches on from bash, so the status line has
 * its own test — a writer and a guard disagreeing about what "accepted" looks
 * like is a silently disabled guard.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADR_STATUSES,
  adrFilename,
  nextNumber,
  padNumber,
  parseAdr,
  parseAdrFilename,
  renderAdr,
  renderIndex,
  statusOf,
  withStatus,
} from '../lib/adr.mjs';

const DATE = '2026-08-28';

test('numbers pad to four digits and widen past 9999', () => {
  assert.equal(padNumber(1), '0001');
  assert.equal(padNumber(42), '0042');
  assert.equal(padNumber(12345), '12345');
});

test('filenames round-trip through the parser', () => {
  const name = adrFilename(7, 'Worktrees by default');
  assert.equal(name, '0007-worktrees-by-default.md');
  assert.deepEqual(parseAdrFilename(name), { number: 7, slug: 'worktrees-by-default' });
});

test('a title that slugifies to nothing still produces a filename', () => {
  assert.equal(adrFilename(3, '!!! ???'), '0003-untitled.md');
});

test('parseAdrFilename rejects what is not an ADR', () => {
  assert.equal(parseAdrFilename('README.md'), null);
  assert.equal(parseAdrFilename('notes.txt'), null);
  assert.equal(parseAdrFilename('adr-7-thing.md'), null);
});

test('nextNumber counts from the highest ever seen, never from the count', () => {
  assert.equal(nextNumber([]), 1);
  assert.equal(nextNumber(['0001-a.md', '0002-b.md']), 3);
  // 0002 deleted: the next record must still be 0003, or every citation of the
  // old 0003 silently reparents onto a different decision.
  assert.equal(nextNumber(['0001-a.md', '0003-c.md']), 4);
  assert.equal(nextNumber(['README.md', '0009-x.md']), 10);
  assert.equal(nextNumber([1, 5, 3]), 6);
});

test('renderAdr emits the header the hook greps for', () => {
  const text = renderAdr({ number: 7, title: 'Worktrees by default', date: DATE });
  assert.match(text, /^# 0007\. Worktrees by default$/m);
  assert.match(text, /^- Status: proposed$/m);
  assert.match(text, /^- Date: 2026-08-28$/m);
  assert.equal(statusOf(text), 'proposed');
});

test('renderAdr is deterministic — same inputs, same bytes', () => {
  const args = { number: 2, title: 'Pick a tracker', date: DATE, deciders: 'ayoub' };
  assert.equal(renderAdr(args), renderAdr(args));
});

test('renderAdr writes the three sections, with placeholders when empty', () => {
  const text = renderAdr({ number: 1, title: 'X', date: DATE });
  assert.match(text, /^## Context$/m);
  assert.match(text, /^## Options considered$/m);
  assert.match(text, /^## Consequences$/m);
  assert.match(text, /\*\*<chosen option>\*\*/);
});

test('renderAdr renders supplied options, marking the chosen one', () => {
  const text = renderAdr({
    number: 1,
    title: 'X',
    date: DATE,
    options: [
      { label: 'Postgres', why: 'no TTL semantics' },
      { label: 'Redis', why: 'TTL is native', chosen: true },
    ],
  });
  assert.match(text, /- \*\*Postgres\*\* — no TTL semantics/);
  assert.match(text, /- \*\*Redis\*\* \*\*\(chosen\)\*\* — TTL is native/);
});

test('renderAdr refuses input it cannot render honestly', () => {
  assert.throws(() => renderAdr({ number: 1, title: '', date: DATE }), /title/);
  assert.throws(() => renderAdr({ number: 1, title: 'X', date: '28/08/2026' }), /ISO-8601/);
  assert.throws(() => renderAdr({ title: 'X', date: DATE }), /integer number/);
  assert.throws(() => renderAdr({ number: 1, title: 'X', date: DATE, status: 'draft' }), /unknown/);
});

test('withStatus replaces only the status line', () => {
  const before = renderAdr({ number: 7, title: 'Worktrees', date: DATE, deciders: 'ayoub' });
  const after = withStatus(before, 'accepted');
  assert.equal(statusOf(after), 'accepted');
  assert.match(after, /^- Date: 2026-08-28$/m);
  assert.match(after, /^- Deciders: ayoub$/m);
  // Every line but the status line is untouched.
  const diff = before.split('\n').filter((l, i) => l !== after.split('\n')[i]);
  assert.equal(diff.length, 1);
  assert.match(diff[0], /^- Status:/);
});

test('superseding links forwards, and parseAdr reads the link back', () => {
  const old = withStatus(renderAdr({ number: 7, title: 'Old', date: DATE }), 'superseded', {
    supersededBy: { number: 9, file: '0009-new.md' },
  });
  assert.match(old, /^- Status: superseded by \[0009\]\(0009-new\.md\)$/m);
  const parsed = parseAdr(old, '0007-old.md');
  assert.equal(parsed.status, 'superseded');
  assert.deepEqual(parsed.supersededBy, { number: 9, file: '0009-new.md' });
});

test('the superseding record links backwards', () => {
  const fresh = renderAdr({
    number: 9,
    title: 'New',
    date: DATE,
    supersedes: { number: 7, file: '0007-old.md' },
  });
  assert.match(fresh, /^- Supersedes: \[0007\]\(0007-old\.md\)$/m);
  assert.deepEqual(parseAdr(fresh, '0009-new.md').supersedes, { number: 7, file: '0007-old.md' });
});

test('withStatus refuses a file that is not an ADR, and an unknown status', () => {
  assert.throws(() => withStatus('# just a doc\n', 'accepted'), /not an ADR/);
  assert.throws(() => withStatus(renderAdr({ number: 1, title: 'X', date: DATE }), 'nope'), /unknown/);
});

test('parseAdr falls back to the filename when the heading is missing', () => {
  assert.equal(parseAdr('- Status: accepted\n', '0004-thing.md').number, 4);
  assert.equal(parseAdr('nothing here', '0004-thing.md').status, null);
});

test('the index is a plain table, sorted by number', () => {
  const out = renderIndex([
    { number: 3, title: 'Third', status: 'accepted', date: DATE, file: '0003-third.md' },
    { number: 1, title: 'First', status: 'proposed', date: DATE, file: '0001-first.md' },
  ]);
  const lines = out.split('\n').filter((l) => l.startsWith('| ['));
  assert.match(lines[0], /^\| \[0001\]\(0001-first\.md\) \| First \| proposed \|/);
  assert.match(lines[1], /^\| \[0003\]\(0003-third\.md\) \| Third \| accepted \|/);
  // No Dataview — the index has to render on GitHub.
  assert.doesNotMatch(out, /```dataview/);
});

test('the index renders a supersede pointer as a link', () => {
  const out = renderIndex([
    {
      number: 1,
      title: 'Old',
      status: 'superseded',
      date: DATE,
      file: '0001-old.md',
      supersededBy: { number: 2, file: '0002-new.md' },
    },
  ]);
  assert.match(out, /superseded by \[0002\]\(0002-new\.md\)/);
});

test('an empty index says so rather than printing an empty table', () => {
  const out = renderIndex([]);
  assert.doesNotMatch(out, /^\| ---/m);
  assert.match(out, /No decision records yet/);
});

test('the status list stays small and includes rejected', () => {
  assert.deepEqual(ADR_STATUSES, ['proposed', 'accepted', 'superseded', 'rejected']);
});
