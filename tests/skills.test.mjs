/**
 * What the shipped skills promise, checked as text (#121).
 *
 * A skill is prose the model follows, so the only test there is for one is
 * that the sentences carrying the invariant are present and the ones carrying
 * the old behaviour are gone. Weak, and still the strongest check available
 * for markdown — the same approach tests/agents.test.mjs takes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;
const skill = (name) => readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');

test('dev-build: the session orchestrates and a builder builds, on the single-unit path too', () => {
  const text = skill('dev-build');
  // The single-unit path dispatches a builder in the background, run by the session.
  assert.match(text, /children: none/);
  const single = text.split('children: none')[1];
  assert.match(single, /`dev-builder`/, 'the single-unit path names the builder');
  assert.match(text, /background/i);
  // The session never implements: no TDD handoff for itself, and no handing the run away.
  assert.doesNotMatch(text, /drive each criterion through `\/dev-tdd`/);
  assert.doesNotMatch(text, /## \d+\. Implement/);
  assert.doesNotMatch(text, /subagent_type: fork/);
  assert.doesNotMatch(text, /general-purpose/);
  assert.match(text, /never hands the run/i);
});

test('dev-build: auto chains waves under direct delivery only, and hedged approval is not approval', () => {
  const text = skill('dev-build');
  assert.match(text, /`auto`/);
  const auto = text.split(/## \d+\. .*`auto`/)[1] ?? '';
  assert.ok(auto.length > 0, 'auto has a section of its own');
  assert.match(auto, /`delivery\.mode: direct`/);
  assert.match(auto, /refused under `pr`/);
  assert.match(auto, /hedged/i);
});

test('dev-build: the closing comment has a shape', () => {
  const text = skill('dev-build');
  const closing = text.split(/## \d+\. Closing comment/)[1]?.split('## ')[0] ?? '';
  assert.ok(closing.length > 0, 'a numbered "Closing comment" section exists');
  for (const item of ['commits', 'tests', 'criteria', '`noticed`', 'blocked']) {
    assert.match(closing, new RegExp(item), `the closing comment lists ${item}`);
  }
});

test('dev-build is no longer than it was before #121', () => {
  const lines = skill('dev-build').trimEnd().split('\n').length;
  assert.ok(lines <= 301, `dev-build/SKILL.md is ${lines} lines; the ceiling is 301`);
});

test('dev-lint-rules: the doctrine batch is proposed with a count, and never written unapproved', () => {
  // The skill is text, so its promises are only testable as text — the same
  // approach the dev-build assertions above take. These four are the ones a
  // rewrite would most easily drop, and each one costs a user something real
  // if it goes: a rule they already have, a guess presented as an answer, a
  // config format migrated behind their back, or an invented module list.
  const text = skill('dev-lint-rules');

  assert.match(text, /rules --doctrine/, 'the doctrine coverage is never assembled by hand');
  assert.match(text, /A `covered` rule is never proposed/);
  assert.match(text, /An `unknown` verdict is not a missing rule/);
  assert.match(text, /flags a legacy `\.eslintrc\*`; it does not migrate it/i);
  assert.match(text, /the placeholder is a\s+question, not a default/);
  assert.match(text, /run `rules --doctrine` again and report the verdicts read back/);

  // The count is §3's rule and §3.5 reuses it rather than inventing a second
  // standard for the same decision.
  const doctrine = text.slice(text.indexOf('## 3.5'), text.indexOf('## 4.'));
  assert.match(doctrine, /\*\*the count\*\*/);
  assert.match(doctrine, /never rewriting the file/);
});
