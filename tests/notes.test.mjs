/**
 * The notes format, offline.
 *
 * Two properties matter more than the rendering, and both are here because
 * losing knowledge is the failure this feature exists to prevent:
 *
 *   1. appending never rewrites what is already in the file;
 *   2. truncation is always announced, never silent.
 *
 * The clock is injected for the same reason every adapter takes its transport as
 * an argument: a function that reads the wall clock cannot be asserted against.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAX_CHARS,
  appendEntry,
  mergeForDisplay,
  parseNotes,
  renderEntry,
} from '../lib/notes.mjs';

const AT = new Date('2026-08-17T09:30:00Z');

test('an entry carries the date and the ticket it was learned under', () => {
  assert.equal(
    renderEntry({ text: 'sync short-circuits on closed issues', id: '#22', now: AT }),
    '## 2026-08-17 — #22\n\nsync short-circuits on closed issues\n',
  );
});

test('off a ticket it says so rather than inventing an ID', () => {
  const entry = renderEntry({ text: 'jq is required by the hook', id: null, now: AT });
  assert.match(entry, /^## 2026-08-17 — no ticket$/m);
});

test('an empty note is refused, not written as a blank heading', () => {
  assert.throws(() => renderEntry({ text: '   ', now: AT }), /needs some text/);
});

test('appending preserves everything already there', () => {
  const first = renderEntry({ text: 'one', id: '#1', now: AT });
  const second = renderEntry({ text: 'two', id: '#2', now: AT });
  const file = appendEntry(appendEntry('', first), second);

  assert.ok(file.includes('one'), 'the first note survived');
  assert.ok(file.includes('two'), 'the second note is there');
  assert.equal(parseNotes(file).length, 2);
});

test('appending to a file with no trailing newline does not run entries together', () => {
  const file = appendEntry('## 2026-01-01 — #9\n\nold', renderEntry({ text: 'new', now: AT }));
  assert.match(file, /old\n\n## 2026-08-17/);
});

test('prose above the first heading is kept, not dropped', () => {
  const entries = parseNotes('What this file is for.\n\n## 2026-08-17 — #22\n\nthe note\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].heading, null);
  assert.equal(entries[0].body, 'What this file is for.');
  assert.equal(entries[1].id, '#22');
});

test('a hand-written hyphen heading parses like the em dash the tool writes', () => {
  const [entry] = parseNotes('## 2026-08-17 - ABC-42\n\nby hand\n');
  assert.equal(entry.id, 'ABC-42');
  assert.equal(entry.date, '2026-08-17');
});

test('the inline notes array still renders, and comes first', () => {
  const { lines } = mergeForDisplay({
    inline: ['from the config array'],
    file: renderEntry({ text: 'from the file', id: '#22', now: AT }),
  });
  assert.equal(lines[0], '  - from the config array');
  assert.ok(lines.join('\n').includes('from the file'));
});

test('no notes at all reads as (none), exactly as it did before', () => {
  assert.deepEqual(mergeForDisplay({ inline: null, file: '' }).lines, ['  (none)']);
});

test('truncation announces itself, names the file, and keeps the newest', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    renderEntry({ text: `note number ${i} `.repeat(20), id: `#${i}`, now: AT }),
  ).reduce((acc, e) => appendEntry(acc, e), '');

  const { lines, truncated } = mergeForDisplay({
    inline: null,
    file: many,
    path: '.dev-workflow.notes.md',
    maxChars: 1000,
  });

  assert.ok(truncated > 0, 'this input is meant to overflow the budget');
  const text = lines.join('\n');
  assert.match(text, /older entr(y|ies) not shown/);
  assert.match(text, /\.dev-workflow\.notes\.md/);
  assert.ok(text.includes('#39'), 'the newest entry is the one worth keeping');
  assert.ok(!text.includes('#0 '), 'the oldest entry was the one dropped');
});

test('a note is never dropped without a word about it', () => {
  const file = Array.from({ length: 10 }, (_, i) =>
    renderEntry({ text: 'x'.repeat(500), id: `#${i}`, now: AT }),
  ).reduce((acc, e) => appendEntry(acc, e), '');

  const { lines, truncated } = mergeForDisplay({ inline: null, file, maxChars: 50 });
  const shown = parseNotes(file).length - truncated;

  assert.ok(shown >= 1, 'at least the newest entry is always shown');
  if (truncated > 0) assert.match(lines.join('\n'), /not shown/);
});

test('the default budget is a number, so a missing config field cannot disable truncation', () => {
  assert.equal(typeof DEFAULT_MAX_CHARS, 'number');
  assert.ok(DEFAULT_MAX_CHARS > 0);
});
