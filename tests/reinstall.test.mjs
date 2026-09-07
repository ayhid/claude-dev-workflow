/**
 * The triage `init` runs on a project that already has the workflow.
 *
 * Whether the installer should offer express, ask for the new settings, or
 * start the wizard over is a decision about a manifest and a config file —
 * and one that cannot be asserted from inside a script built out of clack
 * prompts. So it is a pure function here, fed text rather than a path, and the
 * script only renders what it decides.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyProject } from '../bin/lib/reinstall.mjs';

const manifest = { installation: { version: '1.18.3' }, files: [] };

const complete = {
  provider: 'github',
  github: { repo: 'acme/api', labels: { 'In Progress': 'status: in progress', Done: 'status: done' } },
  language: 'English',
  states: { start: 'In Progress', review: 'In Review', done: 'Done', ladder: ['Backlog', 'In Progress', 'Done'] },
  branch: { pattern: '<ID>-<slug>', base: 'main', mode: 'worktree' },
  delivery: { mode: 'pr' },
  commit: { pattern: 'type(scope): description (<ID>)', position: 'suffix', noTicketEscape: 'chore(no-ticket)' },
};

test('no config is a fresh project, whether or not the files are installed', () => {
  assert.equal(classifyProject({ manifest: null, configText: null }).kind, 'fresh');
  const withFiles = classifyProject({ manifest, configText: null });
  assert.equal(withFiles.kind, 'fresh');
  // The version is still reported: the wizard's last step names it.
  assert.equal(withFiles.installed, '1.18.3');
});

test('a complete config is an express candidate, and its parsed form comes back', () => {
  const r = classifyProject({ manifest, configText: JSON.stringify(complete) });
  assert.equal(r.kind, 'express');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.config, complete);
  assert.equal(r.installed, '1.18.3');
});

test('a config predating a setting needs that key, in registry order', () => {
  const { delivery, commit, ...older } = complete;
  const r = classifyProject({ manifest, configText: JSON.stringify(older) });
  assert.equal(r.kind, 'needs-keys');
  assert.deepEqual(
    r.missing.map((e) => e.key),
    ['delivery.mode', 'commit.position', 'commit.pattern', 'commit.noTicketEscape'],
  );
});

test('a config with no manifest behind it is still triaged on the config alone', () => {
  const r = classifyProject({ manifest: null, configText: JSON.stringify(complete) });
  assert.equal(r.kind, 'express');
  assert.equal(r.installed, null);
});

test('unreadable JSON is corrupt, never express', () => {
  const r = classifyProject({ manifest, configText: '{ "provider": ' });
  assert.equal(r.kind, 'corrupt');
  assert.equal(r.config, null);
  assert.deepEqual(r.missing, []);
});

test('valid JSON that is not an object is corrupt too', () => {
  assert.equal(classifyProject({ manifest, configText: '[]' }).kind, 'corrupt');
  assert.equal(classifyProject({ manifest, configText: '"yes"' }).kind, 'corrupt');
  assert.equal(classifyProject({ manifest, configText: 'null' }).kind, 'corrupt');
});

test('the recommendation is express when nothing is missing, keep-and-add otherwise', () => {
  assert.equal(classifyProject({ manifest, configText: JSON.stringify(complete) }).recommended, 'express');
  const { commit, ...older } = complete;
  assert.equal(classifyProject({ manifest, configText: JSON.stringify(older) }).recommended, 'keep');
  assert.equal(classifyProject({ manifest, configText: '{' }).recommended, 'replace');
  assert.equal(classifyProject({ manifest, configText: null }).recommended, null);
});
