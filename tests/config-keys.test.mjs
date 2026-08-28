/**
 * The config-key registry, and the one property that makes it safe to prompt on.
 *
 * Express mode asks about a key missing from `.dev-workflow.json` on the
 * grounds that missing means *never answered*. That is only true for keys
 * `buildConfig` writes unconditionally — for the ones it omits when the answer
 * is blank (`reviewer`, `notes`, `states.abandon`…), missing means *answered,
 * with silence*, and asking again every update would be exactly the re-asking
 * `--update` exists to avoid.
 *
 * Nothing about the registry states that on its own, so the first test here
 * checks it against `buildConfig`'s real output. A key added to the registry
 * that the wizard does not always write fails there rather than by nagging
 * somebody once a release.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFIG_KEYS,
  defaultForKey,
  describeValue,
  getConfigKey,
  hasConfigKey,
  missingConfigKeys,
  setConfigKey,
} from '../bin/lib/config-keys.mjs';
import { buildConfig } from '../bin/lib/wizard-config.mjs';

/** A full GitHub run of the wizard, as `bin/install.mjs` assembles it. */
const githubConfig = () =>
  buildConfig({
    provider: 'github',
    identity: {
      github: {
        repo: 'acme/api',
        labels: { 'In Progress': 'status: in progress', 'In Review': 'status: in review', Done: 'status: done' },
      },
    },
    language: 'English',
    states: {
      start: 'In Progress',
      review: 'In Review',
      done: 'Done',
      abandon: 'Backlog',
      ladder: ['Backlog', 'In Progress', 'In Review', 'Done'],
    },
    branchMode: 'worktree',
    base: 'main',
    useTypedBranches: false,
    deliveryMode: 'pr',
    position: 'suffix',
    requireType: true,
    enforce: true,
    commitTypes: ['feat', 'fix', 'chore'],
    issueTypes: [],
    priorities: null,
    repos: [{ path: '.', checks: ['npm test'] }],
  });

/** And a full YouTrack one. */
const youtrackConfig = () =>
  buildConfig({
    provider: 'youtrack',
    identity: { baseUrl: 'https://acme.youtrack.cloud', project: 'ABC', projectId: '0-1' },
    language: 'French',
    states: {
      start: 'In Progress',
      review: 'In Review',
      done: 'Done',
      abandon: 'Submitted',
      ladder: ['Submitted', 'In Progress', 'In Review', 'Done'],
    },
    branchMode: 'branch',
    base: 'develop',
    useTypedBranches: true,
    branchTypes: { Bug: 'fix' },
    deliveryMode: 'direct',
    position: 'prefix',
    requireType: true,
    enforce: false,
    issueTypes: ['Bug'],
    priorities: ['Normal'],
    defaultPriority: 'Normal',
  });

// --- the registry's own shape -------------------------------------------------

test('every registry key is one the wizard always writes', () => {
  for (const config of [githubConfig(), youtrackConfig()]) {
    for (const entry of CONFIG_KEYS) {
      if (entry.appliesTo && !entry.appliesTo(config)) continue;
      assert.ok(
        hasConfigKey(config, entry.key),
        `${entry.key} is in the registry but buildConfig did not write it — absent would mean "answered blank", and express would re-ask it forever`,
      );
    }
  }
});

test('a config the wizard just wrote is missing nothing', () => {
  assert.deepEqual(missingConfigKeys(githubConfig()), []);
  assert.deepEqual(missingConfigKeys(youtrackConfig()), []);
});

test('the keys nothing may ask about on its own are not in the registry', () => {
  // Each of these is omitted from a config *because of an answer*, so asking
  // again would be re-asking. `states.abandon` is the one that matters most:
  // it has no default anywhere, and must never gain one here.
  const keys = CONFIG_KEYS.map((e) => e.key);
  for (const forbidden of [
    'states.abandon',
    'reviewer',
    'repos',
    'notes',
    'issueTypes',
    'priorities',
    'defaultPriority',
    'branch.types',
    'branch.worktreeDir',
    'delivery.remote',
    'commit.types',
    'commit.requireType',
    'commit.enforce',
  ]) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must not be asked about one key at a time`);
  }
});

test('every entry is answerable, and a select defaults to one of its own options', () => {
  const seen = new Set();
  for (const entry of CONFIG_KEYS) {
    assert.ok(!seen.has(entry.key), `${entry.key} appears twice`);
    seen.add(entry.key);

    assert.ok(entry.message, `${entry.key} has no question`);
    assert.ok(['select', 'text'].includes(entry.type), `${entry.key} has no renderable type`);
    assert.equal(typeof entry.default, 'function', `${entry.key} has no default`);

    if (entry.type !== 'select') continue;
    for (const config of [githubConfig(), youtrackConfig(), {}]) {
      if (entry.appliesTo && !entry.appliesTo(config)) continue;
      const fallback = defaultForKey(entry, config);
      assert.ok(
        entry.options.some((o) => o.value === fallback),
        `${entry.key} defaults to ${fallback}, which is not one of its options`,
      );
    }
  }
});

// --- presence, not truthiness -------------------------------------------------

test('a key present with a falsy value is present', () => {
  const config = { reviewer: '', commit: { enforce: false }, states: { ladder: [] } };
  assert.equal(hasConfigKey(config, 'reviewer'), true);
  assert.equal(hasConfigKey(config, 'commit.enforce'), true);
  assert.equal(hasConfigKey(config, 'states.ladder'), true);
  assert.equal(hasConfigKey(config, 'states.start'), false);
  assert.equal(hasConfigKey(config, 'branch.mode'), false);
});

test('a non-object on the way down means the leaf is not there', () => {
  const config = { branch: 'main' };
  assert.equal(hasConfigKey(config, 'branch.mode'), false);
  assert.equal(getConfigKey(config, 'branch.mode'), undefined);
});

test('an inherited property is not an answer', () => {
  assert.equal(hasConfigKey({}, 'constructor'), false);
  assert.equal(hasConfigKey({}, 'toString'), false);
});

// --- adding a key -------------------------------------------------------------

test('a new key is appended, and nothing already answered moves', () => {
  const config = { provider: 'github', language: 'English', states: { start: 'Doing', done: 'Shipped' } };
  const before = JSON.stringify(config);

  setConfigKey(config, 'states.review', 'Reviewing');
  setConfigKey(config, 'delivery.mode', 'pr');

  assert.deepEqual(Object.keys(config), ['provider', 'language', 'states', 'delivery']);
  assert.deepEqual(Object.keys(config.states), ['start', 'done', 'review']);
  assert.equal(config.states.start, 'Doing');
  assert.ok(before.startsWith('{"provider":"github","language":"English"'));
});

test('missing keys come back in registry order, so a derived default sees its source', () => {
  const config = { provider: 'youtrack', baseUrl: 'https://acme.youtrack.cloud', project: 'ABC' };
  const missing = missingConfigKeys(config);
  const order = missing.map((e) => e.key);

  assert.ok(order.includes('commit.position'));
  assert.ok(order.indexOf('commit.position') < order.indexOf('commit.pattern'));

  // What the no-TTY path would write, in the order it would write it.
  for (const entry of missing) setConfigKey(config, entry.key, defaultForKey(entry, config));

  assert.equal(config.commit.position, 'suffix');
  assert.equal(config.commit.pattern, 'type(scope): description (<ID>)');
  assert.deepEqual(config.states.ladder, ['In Progress', 'In Review', 'Done']);
  assert.deepEqual(missingConfigKeys(config), []);
});

test('a prefix project gets the prefix pattern, not the default one', () => {
  const config = { provider: 'youtrack', commit: { position: 'prefix' } };
  for (const entry of missingConfigKeys(config)) setConfigKey(config, entry.key, defaultForKey(entry, config));
  assert.equal(config.commit.pattern, '<ID> type(scope): description');
});

// --- what each project is asked -----------------------------------------------

test('a GitHub project is not asked for a ladder on its own', () => {
  // Every rung but the first needs a label mapped onto it, and that mapping is
  // the wizard's business. Answering the ladder alone would leave
  // `github.labels` describing the old one.
  const github = missingConfigKeys({ provider: 'github', github: { repo: 'acme/api' } }).map((e) => e.key);
  assert.ok(!github.includes('states.ladder'));

  const youtrack = missingConfigKeys({ provider: 'youtrack' }).map((e) => e.key);
  assert.ok(youtrack.includes('states.ladder'));
});

test('the tracker is proposed from the config, never from nothing', () => {
  const guess = (config) => defaultForKey(CONFIG_KEYS.find((e) => e.key === 'provider'), config);
  assert.equal(guess({ baseUrl: 'https://acme.youtrack.cloud' }), 'youtrack');
  assert.equal(guess({ github: { repo: 'acme/api' } }), 'github');
});

test('a GitHub project with no type labels is not proposed typed branches', () => {
  const pattern = (config) => defaultForKey(CONFIG_KEYS.find((e) => e.key === 'branch.pattern'), config);
  assert.equal(pattern({ provider: 'github', github: { labels: {} } }), '<ID>-<slug>');
  assert.equal(pattern({ provider: 'github', github: { labels: { type: { Bug: 'bug' } } } }), '<type>/<ID>-<slug>');
  assert.equal(pattern({ provider: 'youtrack' }), '<type>/<ID>-<slug>');
});

test('nothing is missing from something that is not a config', () => {
  assert.deepEqual(missingConfigKeys(null), []);
  assert.deepEqual(missingConfigKeys([]), []);
  assert.deepEqual(missingConfigKeys('{}'), []);
});

test('a value is reported in the shape it was written', () => {
  assert.equal(describeValue(['A', 'B']), 'A, B');
  assert.equal(describeValue('suffix'), 'suffix');
});
