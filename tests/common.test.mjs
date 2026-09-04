/**
 * The shared plumbing every command module goes through.
 *
 * Small, and worth its own file: `resolveRepo` decides which checkout six
 * commands act on, and a defect there sends work to a directory that is nearly
 * the right one.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { preview, resolveRepo, takeValue, UserError, withMetrics } from '../scripts/cmd/common.mjs';

const single = { repos: [{ path: '.' }] };
const many = { repos: [{ path: 'api' }, { path: 'web' }] };

test('takeValue returns the argument at the given index', () => {
  assert.equal(takeValue(['--repo', 'web'], 1, '--repo'), 'web');
});

test('takeValue refuses a missing value, naming the flag', () => {
  assert.throws(() => takeValue(['--repo'], 1, '--repo'), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /--repo/);
    return true;
  });
});

test('takeValue refuses a value eaten by the next flag rather than by the end of the line', () => {
  // `land --repo --apply` is the case from #66: without this, --apply is
  // swallowed as the repo path and the flag that makes the write real
  // silently disappears.
  assert.throws(() => takeValue(['--repo', '--apply'], 1, '--repo'), /--repo/);
  assert.throws(() => takeValue(['--repo', '-x'], 1, '--repo'), /--repo/);
});

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

/**
 * Where `withMetrics` puts the log (#42).
 *
 * `.dev-workflow.json` is tracked, so a worktree carries its own copy and
 * `loadConfig`'s upward walk resolves the project root to the *worktree* when a
 * command runs from inside one. The log then follows it, and `land` deletes the
 * directory it just wrote the close into.
 */
function metricsFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'metrics-path-'));
  const main = join(tmp, 'repo');
  const wt = join(main, '.worktrees', 'fix-1-thing');
  mkdirSync(wt, { recursive: true });
  // Pre-created so `record` stays silent: the "created …" notice on stderr is
  // existing behaviour, not what these tests are about.
  writeFileSync(join(main, LOG), '');
  return { main, wt };
}

const LOG = '.dev-workflow.metrics.jsonl';
const CONFIG = { states: { start: 'In Progress', done: 'Done', abandon: 'Backlog' } };
const okProvider = (state) => ({ name: 'github', setState: async () => ({ ok: true, state }) });

test('a transition made inside a worktree is logged in the main checkout', async () => {
  const { main, wt } = metricsFixture();

  const provider = withMetrics(okProvider('Done'), {
    config: CONFIG,
    root: wt,
    mainCheckout: async () => main,
  });
  const moved = await provider.setState('#1', 'done');

  assert.equal(moved.ok, true);
  assert.match(readFileSync(join(main, LOG), 'utf8'), /"event":"done","id":"#1"/);
  assert.equal(existsSync(join(wt, LOG)), false, 'nothing may be written into the worktree');
});

test('the close finds the start that was recorded from the root', async () => {
  // The whole point of moving the path: `starts` and `elapsedMs` are computed
  // against the log the close is appended to, so a split log silently produces
  // `elapsedMs: null` rather than a wrong number anyone would notice.
  const { main, wt } = metricsFixture();
  const at = new Date('2026-08-30T10:00:00.000Z');
  writeFileSync(
    join(main, LOG),
    `${JSON.stringify({ at: at.toISOString(), event: 'start', id: '#1', state: 'In Progress', provider: 'github' })}\n`,
  );

  const provider = withMetrics(okProvider('Done'), {
    config: CONFIG,
    root: wt,
    mainCheckout: async () => main,
    now: () => new Date(at.getTime() + 60_000),
  });
  await provider.setState('#1', 'done');

  const close = JSON.parse(readFileSync(join(main, LOG), 'utf8').trim().split('\n').at(-1));
  assert.equal(close.elapsedMs, 60_000);
  assert.equal(close.starts, 1);
});

test('with no worktree in play the path is the one it has always been', async () => {
  const { main } = metricsFixture();

  const provider = withMetrics(okProvider('Done'), {
    config: CONFIG,
    root: main,
    mainCheckout: async (dir) => dir,
  });
  await provider.setState('#1', 'done');

  assert.match(readFileSync(join(main, LOG), 'utf8'), /"event":"done"/);
});

test('an unresolvable checkout falls back to the root and never fails the command', async () => {
  // Metrics rule 2: an instrument that breaks what it measures is worse than
  // none. Not a git repository, git missing, `worktree list` refusing — the
  // ticket still moves.
  const { main } = metricsFixture();

  const provider = withMetrics(okProvider('Done'), {
    config: CONFIG,
    root: main,
    mainCheckout: async () => {
      throw new Error('not a git repository');
    },
  });
  const moved = await provider.setState('#1', 'done');

  assert.equal(moved.ok, true);
  assert.match(readFileSync(join(main, LOG), 'utf8'), /"event":"done"/);
});

test('the checkout is resolved once, however many transitions there are', async () => {
  // One `git worktree list` per command at most. Every command takes its
  // provider from `context()`, so an unmemoised lookup would be a subprocess
  // per ticket `sync` reconciles.
  const { main, wt } = metricsFixture();
  let calls = 0;

  const provider = withMetrics(okProvider('Done'), {
    config: CONFIG,
    root: wt,
    mainCheckout: async () => {
      calls += 1;
      return main;
    },
  });
  await provider.setState('#1', 'done');
  await provider.setState('#2', 'done');

  assert.equal(calls, 1);
});
