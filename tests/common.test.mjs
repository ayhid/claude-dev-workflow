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

// --- which repo the caller is standing in (#15) --------------------------------

test('with several repos, the working directory answers before the refusal does', () => {
  assert.deepEqual(resolveRepo(many, '/r', '', '/r/web'), { path: 'web', dir: '/r/web' });
  assert.deepEqual(resolveRepo(many, '/r', undefined, '/r/api/src/deep'), {
    path: 'api',
    dir: '/r/api',
  });
});

test('a worktree resolves to the repo it was cut from', () => {
  // The whole of #15: `branch.worktreeDir` is relative to its repo, so the
  // branch lives *under* a configured path and can never be named by one. Before
  // this, `land` could not be pointed at the branch it existed to land.
  assert.deepEqual(resolveRepo(many, '/r', '', '/r/web/.worktrees/feat-12-thing'), {
    path: 'web',
    dir: '/r/web',
  });
});

test('the repo the caller is in wins over the root that contains it', () => {
  // A project listing `.` has two answers for everything. The root is the
  // fallback, not the match.
  const withRoot = { repos: [{ path: '.' }, { path: 'web' }] };
  assert.deepEqual(resolveRepo(withRoot, '/r', '', '/r/web/.worktrees/x'), {
    path: 'web',
    dir: '/r/web',
  });
  assert.deepEqual(resolveRepo(withRoot, '/r', '', '/r/docs'), { path: '.', dir: '/r' });
});

test('a sibling whose name starts the same is not inside', () => {
  // String prefixes would match `/r/web-legacy` against `/r/web`, and send the
  // work to a repo that is nearly the right one.
  assert.throws(() => resolveRepo(many, '/r', '', '/r/web-legacy'), /configures 2 repos/);
});

test('a working directory in none of them is still refused, and says both ways out', () => {
  assert.throws(() => resolveRepo(many, '/r', '', '/elsewhere'), UserError);
  assert.throws(() => resolveRepo(many, '/r', '', '/r'), /pass --repo <path>/);
  assert.throws(() => resolveRepo(many, '/r', '', '/r'), /from inside one of them/);
});

test('an explicit --repo still wins over the working directory', () => {
  // Inference fills a gap; it does not overrule what the caller asked for.
  assert.deepEqual(resolveRepo(many, '/r', 'api', '/r/web'), { path: 'api', dir: '/r/api' });
});

test('preview caps a list and says how much it left out', () => {
  assert.deepEqual(preview(['a', 'b'], 5), ['a', 'b']);
  assert.deepEqual(preview(['a', 'b', 'c'], 2), ['a', 'b', '  … and 1 more']);
  assert.deepEqual(preview([], 2), []);
});
