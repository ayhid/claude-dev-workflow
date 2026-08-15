import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFIG_FILES,
  DEFAULTS,
  deepMerge,
  findConfigFile,
  formatConfig,
  ladderOf,
  loadConfig,
  projectRootFor,
  rankOf,
} from '../lib/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  writeFileSync(join(root, '.dev-workflow.json'), '{}');
  assert.equal(findConfigFile(join(root, 'a', 'b')), join(root, '.dev-workflow.json'));
});

test('findConfigFile accepts .claude/dev-workflow.json', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'dev-workflow.json'), '{}');
  assert.equal(findConfigFile(root), join(root, '.claude', 'dev-workflow.json'));
});

test('a root .dev-workflow.json wins over .claude/dev-workflow.json', () => {
  const root = scratch();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'dev-workflow.json'), '{}');
  writeFileSync(join(root, '.dev-workflow.json'), '{}');
  assert.equal(findConfigFile(root), join(root, '.dev-workflow.json'));
});

test('findConfigFile returns null when there is none', () => {
  assert.equal(findConfigFile(scratch()), null);
});

test('projectRootFor climbs out of .claude', () => {
  assert.equal(projectRootFor('/x/y/.claude/dev-workflow.json'), '/x/y');
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
    join(root, '.dev-workflow.json'),
    JSON.stringify({ baseUrl: 'https://acme.youtrack.cloud/', project: 'ABC', states: { done: 'Fixed' } }),
  );
  const { config } = loadConfig({ dir: root, env: {} });
  assert.equal(config.project, 'ABC');
  assert.equal(config.states.done, 'Fixed');
  assert.equal(config.states.start, 'In Progress', 'unspecified states keep their defaults');
});

test('loadConfig strips a trailing slash from baseUrl', () => {
  const root = scratch();
  writeFileSync(join(root, '.dev-workflow.json'), JSON.stringify({ baseUrl: 'https://acme.cloud///' }));
  assert.equal(loadConfig({ dir: root, env: {} }).config.baseUrl, 'https://acme.cloud');
});

test('environment overrides the file', () => {
  const root = scratch();
  writeFileSync(join(root, '.dev-workflow.json'), JSON.stringify({ baseUrl: 'https://a.cloud', project: 'ABC' }));
  const { config } = loadConfig({ dir: root, env: { YOUTRACK_PROJECT: 'ZZZ' } });
  assert.equal(config.project, 'ZZZ');
  assert.equal(config.baseUrl, 'https://a.cloud');
});

test('an empty environment variable does not override', () => {
  const root = scratch();
  writeFileSync(join(root, '.dev-workflow.json'), JSON.stringify({ project: 'ABC' }));
  assert.equal(loadConfig({ dir: root, env: { YOUTRACK_PROJECT: '' } }).config.project, 'ABC');
});

test('loadConfig reports invalid JSON by path', () => {
  const root = scratch();
  writeFileSync(join(root, '.dev-workflow.json'), '{ not json');
  assert.throws(() => loadConfig({ dir: root, env: {} }), /is not valid JSON/);
});

test('loadConfig rejects a non-object config', () => {
  const root = scratch();
  writeFileSync(join(root, '.dev-workflow.json'), '[1,2]');
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
  assert.match(out, /instance:\s+MISSING — run \/dev-init/);
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

// --- the JS walk and the bash walk must not drift -----------------------------
//
// lib/config.mjs exists because three copies of this upward walk had already
// drifted apart once. Two of them survive by necessity: the hook is bash, so it
// cannot import this module. Pinning the lists against each other is the only
// thing keeping a rename from silently making the hook read a different file
// than the runtime does.

test('the bash hook probes the same config names, in the same order', () => {
  const hook = readFileSync(join(ROOT, 'hooks', 'check-commit-ticket.sh'), 'utf8');

  const loop = hook.match(/for rel in ([^;]+); do/);
  assert.ok(loop, 'could not find the config-name loop in check-commit-ticket.sh');

  const fromBash = loop[1].trim().split(/\s+/);
  // The JS list uses path.join, which is backslash-separated on Windows; the
  // hook is POSIX shell and always uses forward slashes.
  const fromJs = CONFIG_FILES.map((p) => p.split(/[/\\]/).join('/'));

  assert.deepEqual(fromBash, fromJs);
});

test('formatConfig shows the repo for a github project, not a YouTrack instance', () => {
  const config = deepMerge(DEFAULTS, {
    provider: 'github',
    github: { repo: 'acme/api', labels: { Done: 'done' } },
  });
  const out = formatConfig(config, '/x/.dev-workflow.json');
  assert.match(out, /provider:\s+github/);
  assert.match(out, /repo:\s+acme\/api/);
  assert.doesNotMatch(out, /instance:/, 'a baseUrl means nothing to a github project');
});

test('formatConfig still shows the instance for a youtrack project', () => {
  const config = deepMerge(DEFAULTS, { baseUrl: 'https://a.cloud', project: 'ABC' });
  const out = formatConfig(config, '/x/.dev-workflow.json');
  assert.match(out, /provider:\s+youtrack/);
  assert.match(out, /instance:\s+https:\/\/a\.cloud/);
});
