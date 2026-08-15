/**
 * Branch naming: rendering, sanitising, and reading an ID back out.
 *
 * The round trip is the point. `dev.mjs land` with no ID and `/dev-done` both
 * infer the ticket from the branch name, so a name that renders but does not
 * parse breaks the far end of the workflow — every rendering test here asserts
 * the parse too.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  issueIdFromBranch,
  issueTypeOf,
  refIdFor,
  renderBranch,
  safeRefSegment,
  slugify,
  worktreePathFor,
} from '../lib/branch.mjs';
import { DEFAULTS, deepMerge, deliveryFor, resolveBranchType } from '../lib/config.mjs';

const gh = (patch = {}) =>
  deepMerge(DEFAULTS, { provider: 'github', github: { repo: 'o/r' }, ...patch });
const yt = (patch = {}) => deepMerge(DEFAULTS, { provider: 'youtrack', project: 'ABC', ...patch });

test('slugify folds accents and caps at five words', () => {
  assert.equal(slugify('Déjà vu on the login screen again'), 'deja-vu-on-the-login');
  assert.equal(slugify('Add a dark mode toggle'), 'add-a-dark-mode-toggle');
  assert.equal(slugify('  MIXED   Case & Punctuation!  '), 'mixed-case-punctuation');
  assert.equal(slugify('one two three four five six', { maxWords: 3 }), 'one-two-three');
});

test('slugify never ends on a dangling article', () => {
  // The five-word cap lands here in practice; "…-discards-an" reads as truncated.
  assert.equal(slugify('dev create silently discards an explicit type'), 'dev-create-silently-discards');
  // A stopword in the middle is doing work and stays.
  assert.equal(slugify('the state of the ladder'), 'the-state-of-the-ladder');
  // Never empties the slug entirely.
  assert.equal(slugify('the'), 'the');
});

test('safeRefSegment removes what git-check-ref-format rejects', () => {
  assert.equal(safeRefSegment('fix: crash ~in [parser]?'), 'fix-crash-in-parser]');
  assert.equal(safeRefSegment('a..b'), 'a.b');
  assert.equal(safeRefSegment('trailing.lock'), 'trailing');
  assert.equal(safeRefSegment('.leading-and-trailing.'), 'leading-and-trailing');
  assert.equal(safeRefSegment('head@{1}'), 'head-1}');
  assert.equal(safeRefSegment('with\tcontrol\nchars'), 'with-control-chars');
});

test('refIdFor keeps a # out of the ref', () => {
  assert.equal(refIdFor(gh(), '#42'), '42');
  assert.equal(refIdFor(gh(), 'o/r#42'), '42');
  assert.equal(refIdFor(yt(), 'ABC-398'), 'ABC-398');
});

test('renderBranch fills the configured pattern', () => {
  const config = gh();
  assert.deepEqual(
    renderBranch(config, { id: '#42', type: 'feat', title: 'Add a dark mode toggle' }),
    { ok: true, branch: 'feat/42-add-a-dark-mode-toggle' },
  );
  assert.equal(issueIdFromBranch(config, 'feat/42-add-a-dark-mode-toggle'), '#42');
});

test('a pattern without <type> renders exactly the pre-gitflow name', () => {
  // The upgrade must not rename anybody's branches. This is that guarantee.
  const config = yt({ branch: { pattern: '<ID>-<slug>' } });
  const r = renderBranch(config, { id: 'ABC-398', type: 'fix', title: 'Redirect 301 map' });
  assert.deepEqual(r, { ok: true, branch: 'ABC-398-redirect-301-map' });
  assert.equal(issueIdFromBranch(config, r.branch), 'ABC-398');
});

test('renderBranch tidies the seams an empty token leaves behind', () => {
  const config = gh({ branch: { pattern: '<type>/<ID>-<slug>' } });
  assert.deepEqual(renderBranch(config, { id: '#7', type: 'chore', title: '' }), {
    ok: true,
    branch: 'chore/7',
  });
});

test('renderBranch refuses rather than rendering a nameless branch', () => {
  const config = gh();
  assert.match(renderBranch(config, { id: '', type: 'feat', title: 'x' }).error, /no issue ID/);
  assert.match(renderBranch(config, { id: '#1', title: 'x' }).error, /<type>/);
});

test('issueIdFromBranch anchors to the first number on GitHub', () => {
  const config = gh();
  // The 500 is part of the description, not the ticket.
  assert.equal(issueIdFromBranch(config, 'fix/42-fix-500-error'), '#42');
  assert.equal(issueIdFromBranch(config, '42-bare'), '#42');
  assert.equal(issueIdFromBranch(config, 'main'), null);
  assert.equal(issueIdFromBranch(config, ''), null);
});

test('issueIdFromBranch honours the project key on YouTrack', () => {
  const config = yt();
  assert.equal(issueIdFromBranch(config, 'feat/ABC-398-redirect-map'), 'ABC-398');
  // A different project's key is not this project's issue.
  assert.equal(issueIdFromBranch(config, 'feat/ABD-1-something'), null);
});

test('issueTypeOf reads a Type field or a mapped label, and admits when it cannot', () => {
  const config = gh({ github: { labels: { type: { Bug: 'kind: bug' } } } });
  assert.equal(issueTypeOf(config, { fields: [{ name: 'Type', value: 'Feature' }] }), 'Feature');
  assert.equal(issueTypeOf(config, { meta: { labels: ['kind: bug'] } }), 'Bug');
  assert.equal(issueTypeOf(config, { meta: { labels: ['other'] } }), null);
});

test('resolveBranchType names the key to add rather than guessing', () => {
  const config = yt();
  assert.deepEqual(resolveBranchType(config, 'Bug'), { ok: true, type: 'fix' });

  const unmapped = resolveBranchType(config, 'Spike');
  assert.equal(unmapped.ok, false);
  assert.match(unmapped.error, /branch\.types\["Spike"\]/);
});

test('an untyped issue falls back only to a configured type', () => {
  assert.deepEqual(resolveBranchType(yt(), null), { ok: true, type: 'chore' });

  const none = resolveBranchType(yt({ branch: { fallbackType: null } }), null);
  assert.equal(none.ok, false);
  assert.match(none.error, /branch\.fallbackType/);
});

test('a branch type outside commit.types is refused — one vocabulary', () => {
  const config = yt({ branch: { types: { Bug: 'bugfix' } } });
  const r = resolveBranchType(config, 'Bug');
  assert.equal(r.ok, false);
  assert.match(r.error, /commit\.types/);
});

test('worktreePathFor flattens the branch into one directory level', () => {
  const config = deepMerge(DEFAULTS, {});
  assert.equal(
    worktreePathFor(config, { repoDir: '/p/repo', branch: 'feat/42-dark-mode' }),
    '/p/repo/.worktrees/feat-42-dark-mode',
  );
  assert.equal(
    worktreePathFor(deepMerge(DEFAULTS, { branch: { worktreeDir: 'wt' } }), {
      repoDir: '/p/repo',
      branch: 'fix/7',
    }),
    '/p/repo/wt/fix-7',
  );
});

test('deliveryFor lets one repo differ from the project', () => {
  const config = deepMerge(DEFAULTS, {
    delivery: { mode: 'direct' },
    repos: [{ path: '.' }, { path: 'app', delivery: { mode: 'pr' } }],
  });
  assert.equal(deliveryFor(config, '.').mode, 'direct');
  assert.equal(deliveryFor(config, 'app').mode, 'pr');
  // Defaults still fill the keys the override did not mention.
  assert.equal(deliveryFor(config, 'app').remote, 'origin');
});
