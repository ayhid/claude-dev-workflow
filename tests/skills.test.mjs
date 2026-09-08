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
