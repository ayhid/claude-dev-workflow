/**
 * What the wizard writes, checked against what the adapters accept.
 *
 * The installer's config used to be assembled inline in a script full of
 * prompts, which cannot run without a TTY — so nothing asserted its output, and
 * the shape a GitHub project needs went unwritten for a release. The assembly
 * now lives in `bin/lib/wizard-config.mjs` as a pure function, and these tests
 * feed its output straight to the real adapter constructors.
 *
 * That is the point: not that the JSON looks right, but that
 * `createGitHubProvider` and `createYouTrackProvider` accept it. Every required
 * key, every "no inference" refusal in `lib/provider.mjs` rule 2, is enforced
 * there — so a wizard that stops emitting one fails here rather than on
 * somebody's first `/dev-task`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildConfig, pickDefaultPriority, proposeProvider } from '../bin/lib/wizard-config.mjs';
import { createGitHubProvider } from '../lib/github.mjs';
import { createYouTrackProvider } from '../lib/youtrack.mjs';

/** Neither adapter is allowed to reach the network to be constructed. */
const run = async () => ({ ok: true, code: 0, stdout: '', stderr: '' });
const fetch = async () => {
  throw new Error('the constructor must not fetch');
};

/** The answers a GitHub run of the wizard collects. */
const githubAnswers = (over = {}) => ({
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
  branchTypes: {},
  deliveryMode: 'pr',
  position: 'suffix',
  requireType: true,
  enforce: true,
  commitTypes: ['feat', 'fix', 'chore'],
  issueTypes: [],
  priorities: null,
  defaultPriority: null,
  repos: [{ path: '.', checks: ['npm test'] }],
  ...over,
});

/** And the answers a YouTrack run collects. */
const youtrackAnswers = (over = {}) => ({
  provider: 'youtrack',
  identity: { baseUrl: 'https://acme.youtrack.cloud', project: 'ABC', projectId: '0-1' },
  language: 'English',
  states: {
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
    abandon: 'Submitted',
    ladder: ['Submitted', 'In Progress', 'In Review', 'Done'],
  },
  branchMode: 'worktree',
  base: 'main',
  useTypedBranches: true,
  branchTypes: { Bug: 'fix', Feature: 'feat' },
  deliveryMode: 'pr',
  position: 'suffix',
  requireType: true,
  enforce: true,
  commitTypes: ['feat', 'fix', 'chore'],
  issueTypes: ['Bug', 'Feature'],
  priorities: ['Critical', 'Normal', 'Minor'],
  defaultPriority: 'Normal',
  repos: [{ path: '.' }],
  ...over,
});

// --- the contract that matters ------------------------------------------------

test('a GitHub wizard run produces a config the GitHub adapter accepts', () => {
  const r = createGitHubProvider({ config: buildConfig(githubAnswers()), run, onWarn: () => {} });
  assert.ok(r.ok, r.error);
  assert.equal(r.provider.name, 'github');
});

test('a YouTrack wizard run produces a config the YouTrack adapter accepts', () => {
  const r = createYouTrackProvider({ config: buildConfig(youtrackAnswers()), fetch, onWarn: () => {} });
  assert.ok(r.ok, r.error);
  assert.equal(r.provider.name, 'youtrack');
});

test('the ladder reaches the config verbatim, first rung included', () => {
  // The first rung is what an issue carrying no ladder label *is*, so dropping
  // it would report every untouched issue as started.
  const config = buildConfig(githubAnswers());
  assert.deepEqual(config.states.ladder, ['Backlog', 'In Progress', 'In Review', 'Done']);
  assert.equal(config.github.labels.Backlog, undefined, 'the first rung needs no label');
});

test('a multi-repo GitHub project gets issuesRepo, which the adapter demands', () => {
  const answers = githubAnswers({ repos: [{ path: 'api' }, { path: 'web' }] });

  // Without it `#123` is ambiguous and the adapter refuses outright.
  const naive = buildConfig(answers);
  assert.equal(naive.github.issuesRepo, 'acme/api');

  const r = createGitHubProvider({ config: naive, run, onWarn: () => {} });
  assert.ok(r.ok, r.error);
});

test('a single-repo GitHub project is not given an issuesRepo it does not need', () => {
  assert.equal(buildConfig(githubAnswers()).github.issuesRepo, undefined);
});

test('an existing issuesRepo answer is never overwritten', () => {
  const config = buildConfig(
    githubAnswers({
      repos: [{ path: 'api' }, { path: 'web' }],
      identity: { github: { repo: 'acme/api', issuesRepo: 'acme/tracker', labels: { Done: 'done' } } },
    }),
  );
  assert.equal(config.github.issuesRepo, 'acme/tracker');
});

test('type labels are written beside the ladder labels, and turn types on', () => {
  const config = buildConfig(
    githubAnswers({ useTypedBranches: true, branchTypes: { Bug: 'fix' }, typeLabels: { Bug: 'bug' } }),
  );
  assert.deepEqual(config.github.labels.type, { Bug: 'bug' });
  assert.equal(config.github.labels['In Progress'], 'status: in progress', 'the ladder labels survive');

  const r = createGitHubProvider({ config, run, onWarn: () => {} });
  assert.ok(r.ok, r.error);
  assert.equal(r.provider.capabilities.types, true, 'a type map is what turns types on');
});

test('without a type map GitHub reports no types, and none is written', () => {
  const config = buildConfig(githubAnswers());
  assert.equal('type' in config.github.labels, false);

  const r = createGitHubProvider({ config, run, onWarn: () => {} });
  assert.ok(r.ok, r.error);
  assert.equal(r.provider.capabilities.types, false);
});

// --- keys that must not appear ------------------------------------------------

test('a GitHub config carries no YouTrack identity and no priorities', () => {
  const config = buildConfig(githubAnswers());

  // `capabilities.priorities` is false for GitHub, so a priority list would be
  // a field nothing ever reads.
  for (const key of ['baseUrl', 'project', 'projectId', 'tokenOpRef', 'priorities', 'defaultPriority', 'issueTypes']) {
    assert.equal(key in config, false, `${key} does not belong in a GitHub config`);
  }
});

test('a YouTrack config keeps its identity, types and priorities', () => {
  const config = buildConfig(youtrackAnswers());
  assert.equal(config.baseUrl, 'https://acme.youtrack.cloud');
  assert.equal(config.project, 'ABC');
  assert.deepEqual(config.priorities, ['Critical', 'Normal', 'Minor']);
  assert.equal(config.defaultPriority, 'Normal');
});

test('tokenOpRef is written when there is one, and only then', () => {
  assert.equal('tokenOpRef' in buildConfig(youtrackAnswers()), false);
  const withRef = buildConfig(
    youtrackAnswers({ identity: { baseUrl: 'https://x.io', project: 'ABC', tokenOpRef: 'op://v/i/credential' } }),
  );
  assert.equal(withRef.tokenOpRef, 'op://v/i/credential');
});

// --- states.abandon -----------------------------------------------------------

test('states.abandon is written when chosen and omitted when declined', () => {
  assert.equal(buildConfig(githubAnswers()).states.abandon, 'Backlog');

  // Left unset it must be *absent*, not empty: `abandon` then says which key to
  // add, where a '' would be a state no tracker has.
  const none = buildConfig(githubAnswers({ states: { ...githubAnswers().states, abandon: '' } }));
  assert.equal('abandon' in none.states, false);
});

// --- branch types -------------------------------------------------------------

test('branch.types is written only when branches carry a type', () => {
  assert.equal('types' in buildConfig(githubAnswers()).branch, false);
  assert.equal(buildConfig(githubAnswers()).branch.pattern, '<ID>-<slug>');

  const typed = buildConfig(youtrackAnswers());
  assert.equal(typed.branch.pattern, '<type>/<ID>-<slug>');
  assert.deepEqual(typed.branch.types, { Bug: 'fix', Feature: 'feat' });
});

test('typed branches with no mapping write no empty types object', () => {
  const config = buildConfig(youtrackAnswers({ branchTypes: {} }));
  assert.equal(config.branch.pattern, '<type>/<ID>-<slug>');
  assert.equal('types' in config.branch, false);
});

// --- the commit block ---------------------------------------------------------

test('the commit pattern follows the chosen ID position', () => {
  assert.equal(buildConfig(githubAnswers()).commit.pattern, 'type(scope): description (<ID>)');
  assert.equal(buildConfig(githubAnswers({ position: 'prefix' })).commit.pattern, '<ID> type(scope): description');
  assert.equal(
    buildConfig(githubAnswers({ requireType: false })).commit.pattern,
    'description (<ID>)',
    'a project without conventional commits gets a pattern without a type',
  );
});

test('requireType and enforce are written only when switched off', () => {
  const on = buildConfig(githubAnswers()).commit;
  assert.equal('requireType' in on, false);
  assert.equal('enforce' in on, false);

  const off = buildConfig(githubAnswers({ requireType: false, enforce: false })).commit;
  assert.equal(off.requireType, false);
  assert.equal(off.enforce, false);
});

// --- the provider key ---------------------------------------------------------

test('the provider is always written, and comes first', () => {
  for (const answers of [githubAnswers(), youtrackAnswers()]) {
    const config = buildConfig(answers);
    assert.equal(config.provider, answers.provider);
    assert.equal(Object.keys(config)[0], 'provider', 'the file should say what it is for on line one');
  }
});

// --- the default priority -----------------------------------------------------

test('pickDefaultPriority keeps a previous choice that still exists', () => {
  assert.equal(pickDefaultPriority(['Critical', 'Normal', 'Minor'], 'Minor'), 'Minor');
});

test('pickDefaultPriority falls back to the normal-looking rung, then the middle', () => {
  assert.equal(pickDefaultPriority(['Critical', 'Normal', 'Minor'], 'Gone'), 'Normal');
  assert.equal(pickDefaultPriority(['P0', 'P1', 'P2'], undefined), 'P1');
  assert.equal(pickDefaultPriority([], 'Normal'), null, 'a tracker with no priorities gets none');
});

// --- which tracker the wizard offers first ------------------------------------

test('proposeProvider follows an explicit provider before anything else', () => {
  assert.equal(proposeProvider({ existing: { provider: 'youtrack' }, detectedSlug: 'acme/api' }), 'youtrack');
  assert.equal(proposeProvider({ existing: { provider: 'github' }, detectedSlug: null }), 'github');
});

test('proposeProvider reads a pre-provider YouTrack config as YouTrack', () => {
  // Configs written before the `provider` key existed have only a baseUrl, and
  // most YouTrack projects are hosted on GitHub. Reading the remote first would
  // greet everyone reconfiguring one with an offer to convert it.
  assert.equal(
    proposeProvider({ existing: { baseUrl: 'https://acme.youtrack.cloud', project: 'ABC' }, detectedSlug: 'acme/api' }),
    'youtrack',
  );
});

test('proposeProvider offers GitHub from a config or a remote, and YouTrack from neither', () => {
  assert.equal(proposeProvider({ existing: { github: { repo: 'acme/api' } } }), 'github');
  assert.equal(proposeProvider({ detectedSlug: 'acme/api' }), 'github');
  assert.equal(proposeProvider({}), 'youtrack');
  assert.equal(proposeProvider(), 'youtrack', 'and with no arguments at all');
});
