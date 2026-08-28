/**
 * What the installer reads off a repository before it asks anything.
 *
 * Everything here is a *proposal* — the wizard shows each answer for
 * confirmation, so a wrong guess costs a keystroke. What must not happen is a
 * confident wrong answer: a slug for a repo that is not on GitHub would put the
 * wizard's first question on the wrong tracker, and an ID position read from the
 * wrong ID shape is a convention nobody chose.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { commitIdPosition, githubRepo } from '../bin/lib/detect.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repo with one remote and a commit subject per line given. */
function repoWith({ origin = null, subjects = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'detect-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);

  for (const [i, subject] of subjects.entries()) {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', subject);
  }
  return dir;
}

// --- githubRepo ---------------------------------------------------------------

test('githubRepo reads owner/name off every spelling of a GitHub remote', () => {
  for (const url of [
    'git@github.com:acme/api.git',
    'git@github.com:acme/api',
    'https://github.com/acme/api.git',
    'https://github.com/acme/api',
    'ssh://git@github.com/acme/api.git',
  ]) {
    assert.equal(githubRepo(repoWith({ origin: url })), 'acme/api', url);
  }
});

test('githubRepo keeps the dots and dashes a repository name may contain', () => {
  assert.equal(githubRepo(repoWith({ origin: 'git@github.com:ay-hid/claude.dev-workflow.git' })), 'ay-hid/claude.dev-workflow');
});

test('githubRepo returns null for anything not on github.com', () => {
  // A slug from a GitLab or self-hosted remote would propose the wrong tracker
  // with the confidence of a detected fact.
  for (const url of [
    'git@gitlab.com:acme/api.git',
    'https://bitbucket.org/acme/api.git',
    'https://git.acme.internal/acme/api.git',
    'git@github.enterprise.acme.com:acme/api.git',
  ]) {
    assert.equal(githubRepo(repoWith({ origin: url })), null, url);
  }
});

test('githubRepo returns null with no origin at all, and outside a repo', () => {
  assert.equal(githubRepo(repoWith()), null);
  assert.equal(githubRepo(mkdtempSync(join(tmpdir(), 'detect-'))), null);
});

// --- commitIdPosition ---------------------------------------------------------

test('commitIdPosition reads the GitHub ID shape when told the project is GitHub', () => {
  const dir = repoWith({
    subjects: ['feat(api): add thing (#12)', 'fix(web): repair it (#13)', 'chore(no-ticket): tidy'],
  });
  assert.equal(commitIdPosition(dir, 'github'), 'suffix');
  // The same history says nothing at all about the YouTrack shape.
  assert.equal(commitIdPosition(dir, 'youtrack'), null);
});

test('commitIdPosition spots a GitHub ID at the front too', () => {
  const dir = repoWith({ subjects: ['#12 feat(api): add thing', '#13 fix(web): repair it'] });
  assert.equal(commitIdPosition(dir, 'github'), 'prefix');
});

test('commitIdPosition still defaults to the YouTrack shape', () => {
  const dir = repoWith({ subjects: ['feat(api): add thing (ABC-12)', 'fix: repair it (ABC-13)'] });
  assert.equal(commitIdPosition(dir), 'suffix');
  assert.equal(commitIdPosition(dir, 'github'), null);
});

test('commitIdPosition returns null when the history says nothing', () => {
  assert.equal(commitIdPosition(repoWith({ subjects: ['initial commit'] }), 'github'), null);
  assert.equal(commitIdPosition(repoWith()), null, 'and on an empty repo');
});
