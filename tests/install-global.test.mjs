/**
 * Routing the payload: the runtime to the machine, the enforcement to the project.
 *
 * A global install splits one file set across two roots. `lib/`, `scripts/` and
 * the two Node hooks — which `import '../lib/…'` and so cannot resolve it across
 * roots — land under `$HOME/.claude/dev-workflow`; the skills, the agents and
 * the two bash guards stay in the project, because a guard that is not there
 * exits 127 and enforcement disappears from a fresh clone without a word.
 *
 * Every install here runs for real into a temporary project with a temporary
 * `$HOME`, passed as `env` rather than set on `process.env`. A dry run proves
 * nothing about a write path.
 */
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAYLOAD_DIR, isOwnedPath } from '../bin/lib/payload.mjs';

// --- AC6: the boundary admits the machine root, and nothing else --------------

const MACHINE = { root: 'machine' };

test('AC6: isOwnedPath admits the machine root when asked about it', () => {
  assert.equal(isOwnedPath(join('lib', 'config.mjs'), MACHINE), true);
  assert.equal(isOwnedPath(join('scripts', 'dev.mjs'), MACHINE), true);
  assert.equal(isOwnedPath(join('hooks', 'session-standup.mjs'), MACHINE), true);
  assert.equal(isOwnedPath(join('_config', 'manifest.json'), MACHINE), true);
});

test('AC6: the three project roots are still admitted, with or without naming the base', () => {
  for (const base of [undefined, {}, { root: 'project' }]) {
    assert.equal(isOwnedPath(join(PAYLOAD_DIR, 'hooks', 'check-commit-ticket.sh'), base), true);
    assert.equal(isOwnedPath(join('.claude', 'skills', 'dev-task', 'SKILL.md'), base), true);
    assert.equal(isOwnedPath(join('.claude', 'agents', 'dev-reader.md'), base), true);
  }
});

test('AC6: everything else is refused on the machine root, traversal included', () => {
  for (const rel of ['', '.', '..', '../x', join('lib', '..', '..', 'x'), '/etc/passwd', 'lib//x', null, 42]) {
    assert.equal(isOwnedPath(rel, MACHINE), false, `${JSON.stringify(rel)} must not be ours on the machine`);
  }
});

test('AC6: a machine-relative path is not ours inside the project, and an unknown base owns nothing', () => {
  // The project boundary is not loosened by the machine one: `lib/config.mjs`
  // at a project's top level is the user's file.
  assert.equal(isOwnedPath(join('lib', 'config.mjs')), false);
  assert.equal(isOwnedPath(join('lib', 'config.mjs'), { root: 'project' }), false);
  assert.equal(isOwnedPath(join('lib', 'config.mjs'), { root: 'elsewhere' }), false);
});

test('AC6: the root is an option, so isOwnedPath still works passed straight to an array method', () => {
  // `tools/check-payload.mjs` calls `paths.some(isOwnedPath)`, which hands the
  // index over as the second argument. A positional root would read index 0 as
  // an unknown root and disown every file.
  assert.equal([join(PAYLOAD_DIR, 'lib', 'config.mjs')].some(isOwnedPath), true);
  assert.deepEqual(['README.md', join('.claude', 'skills', 'dev-task', 'SKILL.md')].filter(isOwnedPath), [
    join('.claude', 'skills', 'dev-task', 'SKILL.md'),
  ]);
});
