/**
 * A pull request title is a release decision (#154).
 *
 * This repository squash-merges with `COMMIT_OR_PR_TITLE`, so a multi-commit
 * pull request lands on `main` as `<title> (#<PR>)` and semantic-release reads
 * that subject and nothing else. Nine merges shipped nothing because the title
 * `land` opened them with carried no type.
 *
 * Asserting the rendered string's *shape* would restate the renderer's own
 * rule back to it. What matters is whether the tool that cuts releases reads it
 * as one, so this runs the real analyzer with the options `release.config.mjs`
 * gives it — and a control, so a test that could never fail cannot pass here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzeCommits } from '@semantic-release/commit-analyzer';

import release from '../release.config.mjs';
import { renderPullRequestTitle } from '../lib/branch.mjs';
import { DEFAULTS, deepMerge } from '../lib/config.mjs';
import { idSyntaxFor } from '../lib/issueid.mjs';
import { extractIssueIds } from '../lib/sync.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const config = deepMerge(DEFAULTS, { provider: 'github', github: { repo: 'o/r' } });

/** The analyzer's options as the release job runs it, not as this test imagines. */
function analyzerOptions() {
  const entry = release.plugins.find(
    (p) => (Array.isArray(p) ? p[0] : p) === '@semantic-release/commit-analyzer',
  );
  assert.ok(entry, 'release.config.mjs no longer runs the commit analyzer — this test measures nothing');
  return Array.isArray(entry) ? (entry[1] ?? {}) : {};
}

/** The release type semantic-release would cut for a single commit. */
const releaseFor = (subject) =>
  analyzeCommits(analyzerOptions(), {
    commits: [{ hash: '0'.repeat(40), message: subject }],
    logger: { log() {} },
    cwd: ROOT,
  });

/** What GitHub writes on the base for a squash merge of a multi-commit PR. */
const squashed = (title, pr) => `${title} (#${pr})`;

test('a rendered feat title, squashed, cuts a minor and still names its issue', async () => {
  const rendered = renderPullRequestTitle(config, {
    id: '#146',
    type: 'feat',
    title: 'fleet: the board selector — readiness and quick-wins order',
  });
  const subject = squashed(rendered.title, 151);

  assert.equal(subject, 'feat(fleet): the board selector — readiness and quick-wins order (#146) (#151)');
  assert.equal(await releaseFor(subject), 'minor');
  assert.ok(extractIssueIds(subject, idSyntaxFor(config)).includes('#146'));
});

test('a rendered fix title, squashed, cuts a patch and still names its issue', async () => {
  const rendered = renderPullRequestTitle(config, {
    id: '#154',
    type: 'fix',
    title: 'land: the pull request title carries no commit type, so a squash merge never cuts a release',
  });
  const subject = squashed(rendered.title, 155);

  assert.equal(await releaseFor(subject), 'patch');
  assert.ok(extractIssueIds(subject, idSyntaxFor(config)).includes('#154'));
});

test('control: the untyped title land used to open with cuts nothing', async () => {
  // The subject #151 actually landed as. Without this, an analyzer that
  // released on anything would pass both tests above.
  assert.equal(await releaseFor('fleet: the board selector — readiness and quick-wins order (#151)'), null);
});
