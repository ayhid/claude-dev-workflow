import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULTS,
  deepMerge,
  findConfigFile,
  formatConfig,
  ladderOf,
  loadConfig,
  projectRootFor,
  rankOf,
} from '../lib/config.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'ytcfg-'));

test('deepMerge merges objects recursively', () => {
  const out = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } });
  assert.deepEqual(out, { a: { b: 1, c: 3 } });
});

test('deepMerge replaces arrays rather than concatenating', () => {
  // A user listing three commit types means exactly those three — not those
  // three plus the eleven defaults.
  const out = deepMerge(DEFAULTS, { commit: { types: ['feat', 'fix'] } });
  assert.deepEqual(out.commit.types, ['feat', 'fix']);
  assert.equal(out.commit.position, 'suffix', 'untouched siblings survive');
});

test('deepMerge does not mutate its inputs', () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { b: 2 } });
  assert.equal(base.a.b, 1);
});

test('findConfigFile walks up from a subdirectory', () => {
  const root = scratch();
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, '.youtrack.json'), '{}');
  assert.equal(findConfigFile(join(root, 'a', 'b')), join(root, '.youtrack.json'));
});

test('findConfigFile accepts .claude/youtrack.json', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'youtrack.json'), '{}');
  assert.equal(findConfigFile(root), join(root, '.claude', 'youtrack.json'));
});

test('a root .youtrack.json wins over .claude/youtrack.json', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'youtrack.json'), '{}');
  writeFileSync(join(root, '.youtrack.json'), '{}');
  assert.equal(findConfigFile(root), join(root, '.youtrack.json'));
});

test('findConfigFile returns null when there is none', () => {
  assert.equal(findConfigFile(scratch()), null);
});

test('projectRootFor climbs out of .claude', () => {
  assert.equal(projectRootFor('/x/y/.claude/youtrack.json'), '/x/y');
  assert.equal(projectRootFor('/x/y/.youtrack.json'), '/x/y');
  assert.equal(projectRootFor(null), null);
});

test('loadConfig fills defaults when no file exists', () => {
  const { config, file } = loadConfig({ dir: scratch(), env: {} });
  assert.equal(file, null);
  assert.equal(config.baseUrl, null);
  assert.equal(config.states.done, 'Done');
  assert.equal(config.language, 'English');
});

test('loadConfig layers the file over the defaults', () => {
  const root = scratch();
  writeFileSync(
    join(root, '.youtrack.json'),
    JSON.stringify({ baseUrl: 'https://acme.youtrack.cloud/', project: 'ABC', states: { done: 'Fixed' } }),
  );
  const { config } = loadConfig({ dir: root, env: {} });
  assert.equal(config.project, 'ABC');
  assert.equal(config.states.done, 'Fixed');
  assert.equal(config.states.start, 'In Progress', 'unspecified states keep their defaults');
});

test('loadConfig strips a trailing slash from baseUrl', () => {
  const root = scratch();
  writeFileSync(join(root, '.youtrack.json'), JSON.stringify({ baseUrl: 'https://acme.cloud///' }));
  assert.equal(loadConfig({ dir: root, env: {} }).config.baseUrl, 'https://acme.cloud');
});

test('environment overrides the file', () => {
  const root = scratch();
  writeFileSync(join(root, '.youtrack.json'), JSON.stringify({ baseUrl: 'https://a.cloud', project: 'ABC' }));
  const { config } = loadConfig({ dir: root, env: { YOUTRACK_PROJECT: 'ZZZ' } });
  assert.equal(config.project, 'ZZZ');
  assert.equal(config.baseUrl, 'https://a.cloud');
});

test('an empty environment variable does not override', () => {
  const root = scratch();
  writeFileSync(join(root, '.youtrack.json'), JSON.stringify({ project: 'ABC' }));
  assert.equal(loadConfig({ dir: root, env: { YOUTRACK_PROJECT: '' } }).config.project, 'ABC');
});

test('loadConfig reports invalid JSON by path', () => {
  const root = scratch();
  writeFileSync(join(root, '.youtrack.json'), '{ not json');
  assert.throws(() => loadConfig({ dir: root, env: {} }), /is not valid JSON/);
});

test('loadConfig rejects a non-object config', () => {
  const root = scratch();
  writeFileSync(join(root, '.youtrack.json'), '[1,2]');
  assert.throws(() => loadConfig({ dir: root, env: {} }), /must contain a JSON object/);
});

test('ladderOf falls back to start/review/done', () => {
  const { config } = loadConfig({ dir: scratch(), env: {} });
  assert.deepEqual(ladderOf(config), ['In Progress', 'In Review', 'Done']);
});

test('rankOf orders the ladder and rejects off-ladder states', () => {
  const config = deepMerge(DEFAULTS, {
    states: { ladder: ['Open', 'In Progress', 'In Review', 'Done'] },
  });
  assert.equal(rankOf(config, 'Open'), 0);
  assert.equal(rankOf(config, 'Done'), 3);
  assert.equal(rankOf(config, 'Blocked'), -1, 'a parked ticket is not on the ladder');
});

test('formatConfig reports a missing instance rather than printing null', () => {
  const { config } = loadConfig({ dir: scratch(), env: {} });
  const out = formatConfig(config, null);
  assert.match(out, /instance:\s+MISSING — run \/yt-init/);
  assert.match(out, /\(none configured — treat the project as a single repo/);
});

test('formatConfig renders repos and the ladder', () => {
  const config = deepMerge(DEFAULTS, {
    baseUrl: 'https://a.cloud',
    project: 'ABC',
    states: { ladder: ['Open', 'Done'] },
    repos: [{ path: 'frontend', checks: ['pnpm test'], env: { NODE: '22' }, remotes: ['origin'] }],
  });
  const out = formatConfig(config, '/x/.youtrack.json');
  assert.match(out, /ladder: Open → Done/);
  assert.match(out, /- frontend/);
  assert.match(out, /checks: pnpm test/);
  assert.match(out, /env: {4}NODE=22/);
});
