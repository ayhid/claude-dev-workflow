/**
 * The shared plumbing every command module goes through.
 *
 * Small, and worth its own file: `resolveRepo` decides which checkout six
 * commands act on, and a defect there sends work to a directory that is nearly
 * the right one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { preview, resolveRepo, UserError } from '../scripts/cmd/common.mjs';

const single = { repos: [{ path: '.' }] };
const many = { repos: [{ path: 'api' }, { path: 'web' }] };

test('an unspecified repo resolves to the only one, however it is spelled', () => {
  // `''` is what arrives from a command whose --repo flag defaults to the empty
  // string. `??` let it through as the path, and the directory became `<root>/`
  // — a real defect, found the first time a command passed its default straight
  // in rather than guarding the call.
  for (const wanted of ['', undefined, null, '.']) {
    assert.deepEqual(
      resolveRepo(single, '/r', wanted),
      { path: '.', dir: '/r' },
      `resolving ${JSON.stringify(wanted)}`,
    );
  }
});

test('a project with no repos configured is a single repo at its root', () => {
  assert.deepEqual(resolveRepo({}, '/r', ''), { path: '.', dir: '/r' });
});

test('a named repo resolves under the root', () => {
  assert.deepEqual(resolveRepo(many, '/r', 'web'), { path: 'web', dir: '/r/web' });
});

test('an unknown repo is refused rather than falling back to the root', () => {
  // Silently working on the wrong repo is worse than stopping.
  assert.throws(() => resolveRepo(many, '/r', 'mobile'), UserError);
  assert.throws(() => resolveRepo(many, '/r', 'mobile'), /not configured \(have: api, web\)/);
});

test('an ambiguous multi-repo project asks rather than picking the first', () => {
  assert.throws(() => resolveRepo(many, '/r', ''), /configures 2 repos/);
});

test('preview caps a list and says how much it left out', () => {
  assert.deepEqual(preview(['a', 'b'], 5), ['a', 'b']);
  assert.deepEqual(preview(['a', 'b', 'c'], 2), ['a', 'b', '  … and 1 more']);
  assert.deepEqual(preview([], 2), []);
});
