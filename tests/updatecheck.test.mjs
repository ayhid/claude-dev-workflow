/**
 * The update check: the network half of `dev.mjs version`.
 *
 * Nothing here touches the network. `latestVersion` takes its transport as an
 * argument for exactly that reason (lib/provider.mjs rule 1), and the invariant
 * every case below defends is the same one: **a failed check is never a throw**.
 * dev.mjs turns a throw into exit 1, and a skill reading that would conclude the
 * command is broken because the user is offline.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UPGRADE_ARGS, latestVersion, render } from '../scripts/cmd/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A fetch that resolves with the given body and status. */
const fakeFetch = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok,
  status,
  json: async () => body,
});

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

// --- the report --------------------------------------------------------------
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

test('the upgrade command is the spelling that actually re-resolves', () => {
  // A bare `npx claude-dev-workflow` re-runs whatever npx cached first: npm keys
  // the cache on the literal spec string and only checks the range it recorded.
  assert.ok(UPGRADE_ARGS.includes('claude-dev-workflow@latest'));
  assert.ok(UPGRADE_ARGS.includes('--update'));
  assert.ok(UPGRADE_ARGS.includes('-y'), 'an unattended run must not stall on npx prompting to install');
});

test('the installer and the payload print the same upgrade command', () => {
  // Two different files tell the user how to update. If they drift, one of them
  // is teaching a spelling that silently re-runs a cached copy.
  const printed = render({ installed: '2.0.0', latest: '2.3.1', checked: true })
    .match(/npx claude-dev-workflow\S*(?: --\S+)*/)[0];
  const installer = readFileSync(join(ROOT, 'bin', 'install.mjs'), 'utf8');
  assert.match(installer, /const UPDATE_COMMAND = 'npx claude-dev-workflow@latest --update'/);
  assert.equal(printed, 'npx claude-dev-workflow@latest --update');
});
