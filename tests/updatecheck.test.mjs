/**
 * The update check: the network half of `dev.mjs version`, and the one-line
 * banner the session-opening commands print from the same answer.
 *
 * Nothing here touches the network, and nothing here writes outside a scratch
 * directory. Every IO the check does is injected (lib/provider.mjs rule 1), and
 * the end-to-end cases run with `DEV_WORKFLOW_NO_NETWORK` set and a pre-seeded
 * cache, so a machine on a plane runs this suite identically to CI.
 *
 * The invariant every case below defends is one sentence: **a failed check is
 * never a throw, and never a banner.** dev.mjs turns a throw into exit 1, and a
 * skill reading that would conclude the command is broken because the user is
 * offline.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_PATH } from '../lib/manifest.mjs';
import { UserError } from '../scripts/cmd/common.mjs';
import {
  CACHE_PATH,
  TTL_MS,
  UPGRADE_COMMAND,
  banner,
  checkForUpdate,
  latestVersion,
  readCache,
  writeCache,
} from '../lib/updatecheck.mjs';
import { UPGRADE_ARGS, render } from '../scripts/cmd/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A fetch that resolves with the given body and status. */
const fakeFetch = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok,
  status,
  json: async () => body,
});

// --- the registry lookup ------------------------------------------------------

test('latestVersion reads the latest dist-tag', async () => {
  assert.equal(await latestVersion(fakeFetch({ latest: '2.3.1', next: '3.0.0-rc.1' })), '2.3.1');
});

test('latestVersion passes the request through', async () => {
  let seen = null;
  await latestVersion(async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ latest: '1.0.0' }) };
  });
  assert.match(seen.url, /^https:\/\/registry\.npmjs\.org\//);
  assert.ok(seen.opts.signal, 'the request must be bounded — a hung registry cannot hang a skill');
});

test('latestVersion returns null on every failure, and throws on none', async () => {
  const cases = {
    'non-200': fakeFetch({ latest: '2.3.1' }, { ok: false, status: 404 }),
    'network error': async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    },
    timeout: async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    },
    'unparseable body': async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }),
    'no latest tag': fakeFetch({ beta: '3.0.0' }),
    'latest is not a string': fakeFetch({ latest: 42 }),
    'empty body': fakeFetch(null),
    'nothing returned at all': async () => undefined,
  };

  for (const [name, impl] of Object.entries(cases)) {
    assert.equal(await latestVersion(impl), null, `expected null for: ${name}`);
  }
});

// --- the banner text ----------------------------------------------------------

test('banner names both versions and the upgrade command', () => {
  assert.equal(banner('1.6.2', '1.6.3'), `An update is available: 1.6.2 → 1.6.3 — ${UPGRADE_COMMAND}`);
});

test('banner is silent on everything that is not "behind"', () => {
  assert.equal(banner('2.0.0', '2.0.0'), null, 'up to date');
  assert.equal(banner('2.1.0', '2.0.0'), null, 'ahead of the registry — a git install tracking main');
  assert.equal(banner(null, '2.0.0'), null, 'no manifest to compare');
  assert.equal(banner('2.0.0', null), null, 'no answer from the registry');
  assert.equal(banner('deadbee', '2.0.0'), null, 'not a version we recognise');
  assert.equal(banner('2.0.0-rc.1', '2.0.0'), null, 'a prerelease is not a triple');
});

// --- the cache file -----------------------------------------------------------

const scratch = () => mkdtempSync(join(tmpdir(), 'dw-updatecheck-'));

const seedCache = (root, contents) => {
  mkdirSync(join(root, dirname(CACHE_PATH)), { recursive: true });
  writeFileSync(join(root, CACHE_PATH), typeof contents === 'string' ? contents : JSON.stringify(contents));
};

test('the cache round-trips through the real filesystem', () => {
  const root = scratch();
  mkdirSync(join(root, dirname(CACHE_PATH)), { recursive: true });

  assert.equal(writeCache(root, { latest: '2.0.0', checkedAt: 1234, announced: '2.0.0' }), true);
  const read = readCache(root);
  assert.deepEqual(read, { found: true, corrupt: false, cache: { latest: '2.0.0', checkedAt: 1234, announced: '2.0.0' } });
});

test('an absent cache is not a corrupt one — the two mean different things', () => {
  assert.deepEqual(readCache(scratch()), { found: false, corrupt: false });
});

test('anything that is not the shape we wrote counts as corrupt', () => {
  for (const contents of ['{not json', '[]', 'null', '"a string"', '{"latest":"2.0.0"}', '{"checkedAt":"yesterday"}']) {
    const root = scratch();
    seedCache(root, contents);
    assert.deepEqual(readCache(root), { found: false, corrupt: true }, `expected corrupt for: ${contents}`);
  }
});

test('a cache missing its optional fields still reads, with nulls', () => {
  const root = scratch();
  seedCache(root, { checkedAt: 99 });
  assert.deepEqual(readCache(root).cache, { checkedAt: 99, latest: null, announced: null });
});

test('an unwritable cache is false, never a throw', () => {
  // No `_config/` directory: the installer always makes one, so this is the
  // "somebody deleted it" / "the directory is read-only" case.
  assert.equal(writeCache(join(scratch(), 'nowhere'), { latest: '2.0.0', checkedAt: 1 }), false);
});

// --- the check itself ---------------------------------------------------------

const NOW = 1_800_000_000_000;

/**
 * In-memory IO, so a case is a table row rather than a scratch directory.
 * `cache` is undefined for "absent", a string for a raw file, an object otherwise.
 */
function fakeIO({ cache, writable = true, latest = '2.3.1', fetchImpl } = {}) {
  const io = { fetches: 0, writes: [] };

  io.readFile = () => {
    if (cache === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return typeof cache === 'string' ? cache : JSON.stringify(cache);
  };
  io.writeFile = (path, text) => {
    if (!writable) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    io.writes.push({ path, record: JSON.parse(text) });
  };
  io.fetchImpl =
    fetchImpl ??
    (async () => {
      io.fetches++;
      return { ok: true, json: async () => ({ latest }) };
    });

  return io;
}

const check = (io, opts = {}) =>
  checkForUpdate({
    root: '/project',
    installed: '2.0.0',
    now: NOW,
    env: {},
    fetchImpl: io.fetchImpl,
    readFile: io.readFile,
    writeFile: io.writeFile,
    ...opts,
  });

test('an absent cache: one lookup, one banner, and the answer written back', async () => {
  const io = fakeIO({ cache: undefined });
  assert.equal(await check(io), `An update is available: 2.0.0 → 2.3.1 — ${UPGRADE_COMMAND}`);
  assert.equal(io.fetches, 1, 'exactly one fetch');
  assert.deepEqual(io.writes.map((w) => w.record), [{ latest: '2.3.1', checkedAt: NOW, announced: '2.3.1' }]);
  assert.ok(io.writes[0].path.endsWith(CACHE_PATH), `wrote ${io.writes[0].path}`);
});

test('a fresh cache answers without touching the network', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - TTL_MS + 1000, announced: null } });
  assert.match(await check(io), /An update is available: 2\.0\.0 → 2\.3\.1/);
  assert.equal(io.fetches, 0);
});

test('saying it does not extend the window — checkedAt is carried, not refreshed', async () => {
  const checkedAt = NOW - TTL_MS + 1000;
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt, announced: null } });
  await check(io);
  assert.equal(io.writes[0].record.checkedAt, checkedAt);
});

test('once per window, not once per command: a /dev-task runs three of these', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - 60_000, announced: '2.3.1' } });
  assert.equal(await check(io), null);
  assert.equal(io.fetches, 0, 'and no network call to reach that conclusion');
  assert.deepEqual(io.writes, [], 'nor a write');
});

test('a stale cache is looked up again, and the banner comes back', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - TTL_MS - 1, announced: '2.3.1' } });
  assert.match(await check(io), /An update is available/);
  assert.equal(io.fetches, 1);
  assert.equal(io.writes[0].record.checkedAt, NOW);
});

test('a timestamp in the future is a moved clock, not a fresh cache', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW + TTL_MS, announced: '2.3.1' } });
  assert.match(await check(io), /An update is available/);
  assert.equal(io.fetches, 1, 'without the upper bound this would read as fresh forever');
});

test('a corrupt cache is silent now, and healed for next time', async () => {
  const io = fakeIO({ cache: '{half-writ' });
  assert.equal(await check(io), null);
  assert.equal(io.fetches, 0, 'a failed check does not earn a lookup');
  assert.deepEqual(io.writes.map((w) => w.record), [{ latest: null, checkedAt: 0, announced: null }]);

  // checkedAt: 0 is always stale, so the very next command does a real lookup.
  const next = fakeIO({ cache: io.writes[0].record });
  assert.match(await check(next), /An update is available/);
  assert.equal(next.fetches, 1);
});

test('a cache that cannot be written is a banner that is not printed', async () => {
  // The write is what records the announcement. Printing without it would mean
  // the line reprints on every command forever, which is worse than silence.
  const io = fakeIO({ cache: undefined, writable: false });
  assert.equal(await check(io), null);
});

test('every registry failure is silent, and writes nothing', async () => {
  for (const [name, fetchImpl] of Object.entries({
    offline: async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    },
    'non-200': async () => ({ ok: false, status: 503, json: async () => ({}) }),
    'unparseable body': async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  })) {
    const io = fakeIO({ cache: undefined, fetchImpl });
    assert.equal(await check(io), null, `expected silence for: ${name}`);
    assert.deepEqual(io.writes, [], `expected no write for: ${name}`);
  }
});

test('no manifest means nothing to be behind — and no lookup on its behalf', async () => {
  const io = fakeIO({ cache: undefined });
  assert.equal(await check(io, { installed: null }), null);
  assert.equal(io.fetches, 0);
});

test('up to date and ahead are both silent, but both record the lookup', async () => {
  for (const installed of ['2.3.1', '2.4.0']) {
    const io = fakeIO({ cache: undefined });
    assert.equal(await check(io, { installed }), null, `expected silence for installed ${installed}`);
    assert.equal(io.fetches, 1);
    assert.deepEqual(
      io.writes.map((w) => w.record),
      [{ latest: '2.3.1', checkedAt: NOW, announced: '2.3.1' }],
      'so the next two commands in this session go nowhere near the network',
    );
  }
});

test('DEV_WORKFLOW_NO_NETWORK suppresses the lookup', async () => {
  const io = fakeIO({ cache: undefined });
  assert.equal(await check(io, { env: { DEV_WORKFLOW_NO_NETWORK: '1' } }), null);
  assert.equal(io.fetches, 0);

  // A fresh cache costs nothing to read, so an answer already paid for is still
  // reported: the variable suppresses the network, not the notice.
  const cached = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - 60_000, announced: null } });
  assert.match(await check(cached, { env: { DEV_WORKFLOW_NO_NETWORK: '1' } }), /An update is available/);
  assert.equal(cached.fetches, 0);
});

test('DEV_WORKFLOW_NO_BANNER suppresses the notice, and the lookup behind it', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - 60_000, announced: null } });
  assert.equal(await check(io, { env: { DEV_WORKFLOW_NO_BANNER: '1' } }), null);
  assert.equal(io.fetches, 0);
  assert.deepEqual(io.writes, []);
});

test('checkForUpdate throws on nothing, whatever the IO does', async () => {
  const explode = () => {
    throw new Error('disk on fire');
  };
  assert.equal(
    await checkForUpdate({
      root: '/project',
      installed: '2.0.0',
      now: NOW,
      env: {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ latest: '2.3.1' }) }),
      readFile: explode,
      writeFile: explode,
    }),
    null,
  );
});

// --- the report ---------------------------------------------------------------
// Output is stable: the same inputs print the same bytes (CLAUDE.md rule 4).

const BASE = {
  installed: '2.0.0',
  latest: '2.0.0',
  checked: true,
  installDate: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  modified: [],
  missing: [],
};

test('render: up to date', () => {
  assert.equal(
    render(BASE),
    [
      'installed  2.0.0  (installed 2026-01-01, updated 2026-01-02)',
      'latest     2.0.0  (npm registry)',
      '',
      'Up to date.',
    ].join('\n'),
  );
});

test('render: an update available names both versions and the command', () => {
  const out = render({ ...BASE, latest: '2.3.1' });
  assert.match(out, /An update is available: 2\.0\.0 → 2\.3\.1/);
  assert.match(out, /npx claude-dev-workflow@latest --update/);
  assert.match(out, /dev\.mjs version --upgrade/);
});

test('render: ahead of the registry reads as a git install, not as nonsense', () => {
  const out = render({ ...BASE, installed: '2.4.0', latest: '2.3.1' });
  assert.match(out, /Ahead of the registry/);
  assert.doesNotMatch(out, /An update is available/);
});

test('render: an unreachable registry is stated, and offers no upgrade', () => {
  assert.match(render({ ...BASE, latest: null }), /latest {5}unknown — could not reach the npm registry/);
  assert.match(render({ ...BASE, latest: null, checked: false }), /latest {5}not checked \(offline\)/);
  assert.doesNotMatch(render({ ...BASE, latest: null }), /An update is available/);
});

test('render: no manifest says so rather than printing a blank', () => {
  const out = render({ installed: null, latest: '2.3.1', checked: true });
  assert.match(out, /installed {2}unknown — no manifest found/);
});

test('render: edited files are listed, sorted, and promised to survive', () => {
  const out = render({ ...BASE, modified: ['_dev-workflow/lib/z.mjs', '_dev-workflow/lib/a.mjs'] });
  assert.match(out, /2 file\(s\) differ from the manifest — an update will keep them:/);
  assert.ok(
    out.indexOf('_dev-workflow/lib/a.mjs') < out.indexOf('_dev-workflow/lib/z.mjs'),
    'the listing is sorted, so the same install prints the same bytes',
  );
});

test('render: missing files offer the repair', () => {
  const out = render({ ...BASE, missing: ['_dev-workflow/lib/gone.mjs'] });
  assert.match(out, /an update restores them/);
  assert.match(out, /--update/);
});

test('render is a pure function of its input', () => {
  assert.equal(render(BASE), render(BASE));
});

// --- one spelling of the upgrade command --------------------------------------

test('the upgrade command is the spelling that actually re-resolves', () => {
  // A bare `npx claude-dev-workflow` re-runs whatever npx cached first: npm keys
  // the cache on the literal spec string and only checks the range it recorded.
  assert.ok(UPGRADE_ARGS.includes('claude-dev-workflow@latest'));
  assert.ok(UPGRADE_ARGS.includes('--update'));
  assert.ok(UPGRADE_ARGS.includes('-y'), 'an unattended run must not stall on npx prompting to install');
});

test('the installer, the report and the banner all print the same command', () => {
  // Three different places tell the user how to update. If any of them drifts,
  // one is teaching a spelling that silently re-runs a cached copy.
  const spell = (text) => text.match(/npx claude-dev-workflow\S*(?: --\S+)*/)[0];

  const installer = readFileSync(join(ROOT, 'bin', 'install.mjs'), 'utf8');
  assert.match(installer, /const UPDATE_COMMAND = 'npx claude-dev-workflow@latest --update'/);

  assert.equal(spell(render({ installed: '2.0.0', latest: '2.3.1', checked: true })), 'npx claude-dev-workflow@latest --update');
  assert.equal(spell(banner('2.0.0', '2.3.1')), 'npx claude-dev-workflow@latest --update');
  assert.equal(UPGRADE_COMMAND, 'npx claude-dev-workflow@latest --update');
});

test('the shipped payload declares that command in exactly one file', () => {
  // The report and the banner import it from the same constant. A second
  // declaration under lib/ or scripts/ is a third spelling waiting to happen.
  const offenders = [];
  for (const dir of ['lib', 'scripts']) {
    const walk = (rel) => {
      for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const next = join(rel, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name.endsWith('.mjs') && readFileSync(join(ROOT, next), 'utf8').includes('npx claude-dev-workflow')) {
          offenders.push(next);
        }
      }
    };
    walk(dir);
  }
  assert.deepEqual(offenders, [join('lib', 'updatecheck.mjs')]);
});

// --- who prints it ------------------------------------------------------------

test('only the session-opening commands emit the banner', () => {
  // The trade this design accepts: a fourth command added later is a place this
  // has to be remembered. This test is what remembers it.
  const emitters = readdirSync(join(ROOT, 'scripts', 'cmd'))
    .filter((f) => f.endsWith('.mjs') && f !== 'common.mjs')
    .filter((f) => readFileSync(join(ROOT, 'scripts', 'cmd', f), 'utf8').includes('emitUpdateBanner'))
    .sort();

  assert.deepEqual(emitters, ['config.mjs', 'standup.mjs', 'status.mjs']);
});

// --- end to end, through the real CLI -----------------------------------------

/**
 * A project with a manifest, a config and (optionally) a seeded cache.
 *
 * The cache is seeded *fresh*, and every run below sets DEV_WORKFLOW_NO_NETWORK:
 * the banner is therefore produced with no network at all, which is what makes
 * these cases run the same on a plane as in CI.
 */
function project({ installed = '1.6.2', cache = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-banner-'));
  mkdirSync(join(dir, dirname(MANIFEST_PATH)), { recursive: true });
  writeFileSync(
    join(dir, MANIFEST_PATH),
    JSON.stringify({ installation: { version: installed }, payloadDir: '_dev-workflow', files: [] }),
  );
  writeFileSync(join(dir, '.dev-workflow.json'), JSON.stringify({ provider: 'github', github: { repo: 'acme/thing' } }));
  if (cache) writeFileSync(join(dir, CACHE_PATH), JSON.stringify(cache));
  return dir;
}

const FRESH = { latest: '1.6.3', checkedAt: Date.now(), announced: null };

const dev = (dir, args, env = {}) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'dev.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, DEV_WORKFLOW_NO_NETWORK: '1', DEV_WORKFLOW_NO_BANNER: '', ...env },
  });

for (const args of [['config'], ['config', '--json']]) {
  test(`dev.mjs ${args.join(' ')}: the banner is on stderr and stdout is unchanged`, () => {
    // One project, run twice: the human report prints the config file's own
    // path, so two scratch directories would differ for a reason that has
    // nothing to do with the banner. DEV_WORKFLOW_NO_BANNER returns before the
    // cache is read or written, so the suppressed run leaves the seed intact.
    const dir = project({ cache: FRESH });
    const without = dev(dir, args, { DEV_WORKFLOW_NO_BANNER: '1' });
    const withBanner = dev(dir, args);

    assert.equal(withBanner.status, 0, withBanner.stderr);
    assert.equal(without.status, 0, without.stderr);

    assert.equal(withBanner.stdout, without.stdout, 'stdout must be byte-for-byte what it was');
    assert.match(withBanner.stderr, /An update is available: 1\.6\.2 → 1\.6\.3 — npx claude-dev-workflow@latest --update/);
    assert.doesNotMatch(without.stderr, /An update is available/);
    assert.doesNotMatch(withBanner.stdout, /An update is available/);
  });
}

test('dev.mjs config --json stays parseable with the banner on', () => {
  const r = dev(project({ cache: FRESH }), ['config', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).provider, 'github');
});

test('the second command of a session is silent, and the cache says why', () => {
  const dir = project({ cache: FRESH });

  const first = dev(dir, ['config']);
  assert.match(first.stderr, /An update is available/);

  const second = dev(dir, ['config']);
  assert.doesNotMatch(second.stderr, /An update is available/);
  assert.equal(second.stdout, first.stdout);

  assert.equal(JSON.parse(readFileSync(join(dir, CACHE_PATH), 'utf8')).announced, '1.6.3');
});

test('an install that is up to date, or ahead, says nothing', () => {
  for (const installed of ['1.6.3', '1.7.0']) {
    const r = dev(project({ installed, cache: FRESH }), ['config']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /An update is available/, `expected silence for installed ${installed}`);
  }
});

test('a project with no manifest at all runs exactly as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-banner-'));
  writeFileSync(join(dir, '.dev-workflow.json'), JSON.stringify({ provider: 'github', github: { repo: 'acme/thing' } }));

  const r = dev(dir, ['config']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /An update is available/);
});

test('a corrupt cache leaves the command untouched', () => {
  const dir = project({ cache: null });
  seedCache(dir, '{ half a write');

  const r = dev(dir, ['config']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /An update is available/);
  assert.match(r.stdout, /provider:/);
});

// --- #86: upgrade prefers a global binary, but only one that is current ---------------

import { upgrade } from '../scripts/cmd/version.mjs';

function installedRoot(version) {
  const root = mkdtempSync(join(tmpdir(), 'dwf-upgrade-'));
  mkdirSync(join(root, '_dev-workflow', '_config'), { recursive: true });
  writeFileSync(
    join(root, '_dev-workflow', '_config', 'manifest.json'),
    JSON.stringify({ installation: { version }, payloadDir: '_dev-workflow', files: [] }),
  );
  return root;
}

/** A runner that answers `claude-dev-workflow version` with `globalVersion` and records every spawn. */
function fakeRunner({ globalVersion }) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'claude-dev-workflow' && args[0] === 'version') return { ok: true, code: 0, stdout: `${globalVersion}\n`, stderr: '' };
    return { ok: true, code: 0, stdout: 'Up to date.', stderr: '' };
  };
  return { run, calls };
}
const cleanVcs = { isClean: async () => ({ ok: true, clean: true, dirty: [] }) };

test('upgrade runs the global binary when it is on PATH and already at the latest version', async () => {
  const root = installedRoot('1.0.0');
  const { run, calls } = fakeRunner({ globalVersion: '2.0.0' });
  await upgrade(root, { run, hasBin: async (b) => b === 'claude-dev-workflow' || b === 'npx', vcs: cleanVcs, latest: '2.0.0' });
  assert.deepEqual(calls.at(-1), ['claude-dev-workflow', 'update', '--dir', root]);
});

test('upgrade falls back to npx@latest when the global binary is behind, or absent, or the latest is unknown', async () => {
  const root = installedRoot('1.0.0');

  const behind = fakeRunner({ globalVersion: '1.5.0' });
  await upgrade(root, { run: behind.run, hasBin: async () => true, vcs: cleanVcs, latest: '2.0.0' });
  assert.deepEqual(behind.calls.at(-1), ['npx', ...UPGRADE_ARGS, '--dir', root], 'a stale global binary is never what upgrade runs');

  const absent = fakeRunner({ globalVersion: '2.0.0' });
  await upgrade(root, { run: absent.run, hasBin: async (b) => b === 'npx', vcs: cleanVcs, latest: '2.0.0' });
  assert.deepEqual(absent.calls.at(-1), ['npx', ...UPGRADE_ARGS, '--dir', root]);
  assert.ok(!absent.calls.some((c) => c[0] === 'claude-dev-workflow'), 'nothing is spawned that is not on PATH');

  const unknown = fakeRunner({ globalVersion: '2.0.0' });
  await upgrade(root, { run: unknown.run, hasBin: async () => true, vcs: cleanVcs, latest: null });
  assert.deepEqual(unknown.calls.at(-1), ['npx', ...UPGRADE_ARGS, '--dir', root], 'with no latest to compare against, npx@latest is the only spelling that provably resolves it');
});

// --- #95: the dirty-tree refusal must cover .claude/agents/ too -----------------------

/** A vcs whose isClean reports dirty only for a path in `dirtyPaths`, clean otherwise. */
function vcsDirtyAt(...dirtyPaths) {
  return {
    isClean: async (_root, { paths }) => {
      const hit = paths.filter((p) => dirtyPaths.includes(p));
      if (hit.length) return { ok: true, clean: false, dirty: hit.map((p) => `M ${p}/example.md`) };
      return { ok: true, clean: true, dirty: [] };
    },
  };
}

test('upgrade refuses when only .claude/agents/ has uncommitted changes', async () => {
  const root = installedRoot('1.0.0');
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  const { run } = fakeRunner({ globalVersion: '1.0.0' });

  await assert.rejects(
    () => upgrade(root, { run, hasBin: async () => false, vcs: vcsDirtyAt(join('.claude', 'agents')), latest: null }),
    (err) => {
      assert.ok(err instanceof UserError, `expected a UserError, got ${err}`);
      assert.match(err.message, /refusing to upgrade/);
      assert.match(err.message, /\.claude[/\\]agents/, 'the refusal must name the dirty root');
      return true;
    },
  );
});

test('the post-upgrade message names all three owned roots', async () => {
  const root = installedRoot('1.0.0');
  const run = async (bin, args) => {
    if (bin === 'npx') {
      writeFileSync(
        join(root, '_dev-workflow', '_config', 'manifest.json'),
        JSON.stringify({ installation: { version: '1.1.0' }, payloadDir: '_dev-workflow', files: [] }),
      );
      return { ok: true, code: 0, stdout: 'installed', stderr: '' };
    }
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };

  const message = await upgrade(root, { run, hasBin: async (b) => b === 'npx', vcs: cleanVcs, latest: null });
  assert.match(message, /_dev-workflow/);
  assert.match(message, /\.claude[/\\]skills/);
  assert.match(message, /\.claude[/\\]agents/, 'the post-upgrade message must name the agents root too');
});

// --- #87: a session greeting says it every session, a command says it once a day ------

test('announceOnce:false returns the banner even when this latest was already announced', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - 60_000, announced: '2.3.1' } });
  assert.equal(await check(io), null, 'the command banner is once per window');
  assert.match(await check(io, { announceOnce: false }), /An update is available: 2\.0\.0 → 2\.3\.1/);
  assert.equal(io.fetches, 0, 'from the cache');
});

test('announceOnce:false still records the announcement, so the commands that follow stay quiet', async () => {
  const io = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - 60_000, announced: null } });
  assert.match(await check(io, { announceOnce: false }), /An update is available/);
  assert.deepEqual(io.writes.map((w) => w.record), [{ latest: '2.3.1', checkedAt: NOW - 60_000, announced: '2.3.1' }]);

  const after = fakeIO({ cache: io.writes[0].record });
  assert.equal(await check(after), null, 'the once-per-window banner has been spent');
});

test('announceOnce:false is still silent when up to date, and still honours the env switches', async () => {
  const io = fakeIO({ cache: { latest: '2.0.0', checkedAt: NOW - 60_000, announced: '2.0.0' } });
  assert.equal(await check(io, { announceOnce: false }), null);
  const behind = fakeIO({ cache: { latest: '2.3.1', checkedAt: NOW - 60_000, announced: null } });
  assert.equal(await check(behind, { announceOnce: false, env: { DEV_WORKFLOW_NO_BANNER: '1' } }), null);
});
