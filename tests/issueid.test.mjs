import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalId, DEFAULT_YOUTRACK_ERE, idSyntaxFor } from '../lib/issueid.mjs';
import { byIssueNumber, extractIssueIds } from '../lib/sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('youtrack ids are scoped to the project key', () => {
  const s = idSyntaxFor({ provider: 'youtrack', project: 'ABC' });
  assert.deepEqual(extractIssueIds('fix ABC-1 and ABC-22, not ABD-3', s), ['ABC-1', 'ABC-22']);
  assert.equal(s.sample, 'ABC-123');
});

test('github ids are #123, with or without an owner/repo prefix', () => {
  const s = idSyntaxFor({ provider: 'github' });
  assert.deepEqual(extractIssueIds('closes #12 and acme/api#34', s), ['#12', 'acme/api#34']);
  assert.deepEqual(extractIssueIds('no ABC-1 here', s), [], 'a YouTrack id is not a GitHub one');
});

test('a project key is escaped before it reaches a RegExp', () => {
  // A key is user input. Interpolating it raw made `A.C` match `ABC-1`, and a
  // key containing `(` threw outright.
  const s = idSyntaxFor({ provider: 'youtrack', project: 'A.C' });
  assert.deepEqual(extractIssueIds('A.C-1 and ABC-2', s), ['A.C-1']);
  assert.doesNotThrow(() => idSyntaxFor({ provider: 'youtrack', project: 'A(B' }).regex);
});

test('the string form still works, and escapes too', () => {
  // Kept so lib/sync.mjs needs no import, and so every pre-existing caller and
  // test keeps passing unchanged.
  assert.deepEqual(extractIssueIds('ABC-1 ABC-1 ABC-2', 'ABC'), ['ABC-1', 'ABC-2']);
  assert.deepEqual(extractIssueIds('A.C-1 ABC-2', 'A.C'), ['A.C-1']);
});

test('scanning twice gives the same answer', () => {
  // A global RegExp carries lastIndex between uses; reusing the syntax object
  // must not make the second scan return less than the first.
  const s = idSyntaxFor({ provider: 'github' });
  const text = 'see #1, #2 and #3';
  assert.deepEqual(extractIssueIds(text, s), extractIssueIds(text, s));
});

test('byIssueNumber orders both id shapes numerically', () => {
  assert.deepEqual(['ABC-10', 'ABC-9', 'ABC-100'].sort(byIssueNumber), [
    'ABC-9',
    'ABC-10',
    'ABC-100',
  ]);
  // #12 used to score 0, so every GitHub issue sorted into one clump.
  assert.deepEqual(['#10', '#9', '#100'].sort(byIssueNumber), ['#9', '#10', '#100']);
});

test('the ERE spelling matches what the bash hook defaults to', () => {
  // Two independent copies of one rule: this file for JavaScript, the hook for
  // bash. They cannot import each other, so they are pinned against each other.
  const hook = readFileSync(join(ROOT, 'hooks', 'check-commit-ticket.sh'), 'utf8');
  const defaults = [...hook.matchAll(/^\s*id_re='([^']+)'/gm)].map((m) => m[1]);

  assert.ok(defaults.length >= 1, 'could not find id_re in the hook');
  for (const d of defaults) {
    assert.equal(d, DEFAULT_YOUTRACK_ERE, 'every hook fallback must be the documented default');
  }
  assert.equal(idSyntaxFor({ provider: 'youtrack' }).ere, DEFAULT_YOUTRACK_ERE);
});

test('the github ERE matches what the hook derives for a github project', () => {
  const hook = readFileSync(join(ROOT, 'hooks', 'check-commit-ticket.sh'), 'utf8');
  const m = /if \.provider == "github" then "([^"]+)"/.exec(hook);
  assert.ok(m, 'could not find the github branch in the hook');
  assert.equal(m[1], idSyntaxFor({ provider: 'github' }).ere);
});

test('a github id has one canonical spelling, whatever was typed', () => {
  // The bug: `dev.mjs start 37` logged `"id":"37"` while every other row spelled
  // it `#37`, so nothing downstream could tell they were one ticket (#43).
  const s = idSyntaxFor({ provider: 'github' });
  assert.equal(s.canonical('#12'), '#12');
  assert.equal(s.canonical('12'), '#12');
  assert.equal(s.canonical(' 12 '), '#12');
  assert.equal(s.canonical('acme/api#12'), '#12');
  // Nothing to canonicalise is returned as it came: refusing here would turn a
  // logging defect into a command that stops working.
  assert.equal(s.canonical('nonsense'), 'nonsense');
  assert.equal(s.canonical(''), '');
  assert.equal(s.canonical(null), '');
});

test('a youtrack id has only one legal spelling already', () => {
  const s = idSyntaxFor({ provider: 'youtrack', project: 'ABC' });
  assert.equal(s.canonical('ABC-12'), 'ABC-12');
  assert.equal(s.canonical('  ABC-12  '), 'ABC-12');
  // No sigil to add and no case rule to apply: inventing one would be the guess
  // rule 2 forbids.
  assert.equal(s.canonical('abc-12'), 'abc-12');
});

test('canonicalId reaches the syntax without every caller building one', () => {
  assert.equal(canonicalId({ provider: 'github' }, '37'), '#37');
  assert.equal(canonicalId({ provider: 'youtrack', project: 'ABC' }, 'ABC-37'), 'ABC-37');
  // No config at all is a youtrack project, the same default idSyntaxFor takes.
  assert.equal(canonicalId(undefined, 'ABC-37'), 'ABC-37');
});
