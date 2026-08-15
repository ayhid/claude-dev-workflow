/**
 * `dev create`'s handling of fields the backend cannot store.
 *
 * Rule 2 says a guess is worse than an error because the wrong guesses are
 * silent. Dropping a field the user explicitly asked for is the same failure
 * wearing a different hat, and it shipped: `priority` warned, `type` did not,
 * so `create "…" "…" Bug` against GitHub discarded the type without a word.
 *
 * These assert on capabilities rather than provider names, which is the point —
 * a third backend is covered the moment it declares what it supports.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unsupportedFieldWarnings } from '../scripts/cmd/create.mjs';

/** A provider stub that declares only what these tests turn on. */
const provider = (name, capabilities) => ({ name, capabilities });

const github = provider('github', { types: false, priorities: false });
const youtrack = provider('youtrack', { types: true, priorities: true });

// --- the regression ----------------------------------------------------------

test('an explicit type is reported when the backend has none', () => {
  const w = unsupportedFieldWarnings(github, { type: 'Bug', typeWasGiven: true });
  assert.equal(w.length, 1);
  assert.match(w[0], /github has no issue types/);
  assert.match(w[0], /"Bug"/, 'the ignored value must appear, or the warning is not actionable');
});

test('the defaulted type is not reported', () => {
  // `run` defaults the type to `Bug`. Warning on that would fire on every
  // create against GitHub, which is how a warning becomes noise.
  assert.deepEqual(unsupportedFieldWarnings(github, { type: 'Bug', typeWasGiven: false }), []);
});

test('type and priority are symmetric', () => {
  const both = unsupportedFieldWarnings(github, {
    type: 'Bug',
    typeWasGiven: true,
    priority: 'Critical',
  });
  assert.equal(both.length, 2, 'both unsupported fields are reported, not just one');
  assert.ok(both.some((w) => /issue types/.test(w)));
  assert.ok(both.some((w) => /priorities/.test(w)));
});

// --- the supported case ------------------------------------------------------

test('a backend that supports both fields warns about neither', () => {
  const w = unsupportedFieldWarnings(youtrack, {
    type: 'Bug',
    typeWasGiven: true,
    priority: 'Critical',
  });
  assert.deepEqual(w, []);
});

test('an empty priority is not a request', () => {
  // `run` defaults priority to '', which means "unspecified", not "Priority ''".
  assert.deepEqual(unsupportedFieldWarnings(github, { priority: '' }), []);
});

test('nothing requested warns about nothing', () => {
  assert.deepEqual(unsupportedFieldWarnings(github, {}), []);
});

// --- capabilities, not names -------------------------------------------------

test('the decision follows capabilities, not the provider name', () => {
  // Same name, opposite capabilities: a name check would return the same
  // answer for both, which is the coupling the adapter layer exists to prevent.
  const capable = provider('github', { types: true, priorities: true });
  assert.deepEqual(unsupportedFieldWarnings(capable, { type: 'Bug', typeWasGiven: true }), []);
  assert.equal(
    unsupportedFieldWarnings(github, { type: 'Bug', typeWasGiven: true }).length,
    1,
  );
});

test('the warning names the provider it came from', () => {
  const other = provider('linear', { types: false, priorities: false });
  const w = unsupportedFieldWarnings(other, { priority: 'P1' });
  assert.match(w[0], /^linear /, 'a warning that does not say which backend refused is a puzzle');
});
