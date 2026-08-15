import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MANIFEST_PATH,
  PAYLOAD_DIR,
  detectDrift,
  installPayload,
  mergeHookIntoSettings,
  planFiles,
  readManifest,
} from '../bin/lib/payload.mjs';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = () => mkdtempSync(join(tmpdir(), 'ytinstall-'));
const install = (projectDir, opts = {}) =>
  installPayload({ sourceRoot: SOURCE_ROOT, projectDir, version: '9.9.9', ...opts });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- what gets planned --------------------------------------------------------

test('planFiles covers the payload and the skills, and nothing else', () => {
  const files = [...planFiles(SOURCE_ROOT).keys()];

  assert.ok(files.includes(join(PAYLOAD_DIR, 'scripts', 'yt.mjs')));
  assert.ok(files.includes(join(PAYLOAD_DIR, 'lib', 'config.mjs')));
  assert.ok(files.includes(join(PAYLOAD_DIR, 'hooks', 'check-commit-ticket.sh')));
  assert.ok(files.includes(join('.claude', 'skills', 'yt-task', 'SKILL.md')));

  // Repo-only material must never reach a user's project.
  assert.ok(!files.some((f) => f.includes('tests')), 'tests must not be installed');
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.includes('README')));
});

test('all four skills are installed under their yt- names', () => {
  const files = [...planFiles(SOURCE_ROOT).keys()];
  for (const skill of ['yt-task', 'yt-bug', 'yt-done', 'yt-init']) {
    assert.ok(
      files.includes(join('.claude', 'skills', skill, 'SKILL.md')),
      `${skill} should be installed`,
    );
  }
});

// --- a fresh install ----------------------------------------------------------

test('a fresh install writes the payload, the skills and the manifest', () => {
  const dir = scratch();
  const result = install(dir);

  assert.equal(result.isUpdate, false);
  assert.ok(existsSync(join(dir, PAYLOAD_DIR, 'scripts', 'yt.mjs')));
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'yt-done', 'SKILL.md')));
  assert.ok(existsSync(join(dir, MANIFEST_PATH)));

  const manifest = readManifest(dir);
  assert.equal(manifest.installation.version, '9.9.9');
  assert.deepEqual(manifest.skills.sort(), ['yt-bug', 'yt-done', 'yt-init', 'yt-task']);
  assert.ok(manifest.files.length > 10);
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test('install works in a project with no package.json at all', () => {
  // The payload has no dependencies precisely so it can live in a Rust or
  // Python repo. Nothing here may assume a Node project.
  const dir = scratch();
  install(dir);
  assert.ok(!existsSync(join(dir, 'package.json')));
  assert.ok(!existsSync(join(dir, PAYLOAD_DIR, 'node_modules')));
  assert.ok(existsSync(join(dir, PAYLOAD_DIR, 'scripts', 'yt.mjs')));
});

test('the commit hook keeps its executable bit', () => {
  const dir = scratch();
  install(dir);
  const mode = statSync(join(dir, PAYLOAD_DIR, 'hooks', 'check-commit-ticket.sh')).mode;
  assert.ok(mode & 0o111, 'the hook is invoked as a script and must stay executable');
});

test('dryRun plans without touching the filesystem', () => {
  const dir = scratch();
  const result = install(dir, { dryRun: true });
  assert.ok(result.written.length > 0);
  assert.ok(!existsSync(join(dir, PAYLOAD_DIR)));
  assert.ok(!existsSync(join(dir, MANIFEST_PATH)));
});

// --- settings merge -----------------------------------------------------------

test('the hook is added to settings.json', () => {
  const dir = scratch();
  const result = install(dir);
  assert.equal(result.hookAdded, true);

  const settings = readJson(join(dir, '.claude', 'settings.json'));
  const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /_youtrack\/hooks\/check-commit-ticket\.sh/);
});

test('an existing user hook survives the install', () => {
  // Overwriting settings.json would silently delete the user's own hooks.
  const dir = scratch();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-formatter' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }],
      },
      permissions: { allow: ['Bash(ls:*)'] },
    }),
  );

  install(dir);
  const settings = readJson(join(dir, '.claude', 'settings.json'));

  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated keys survive');
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'my-formatter');
  const pre = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command);
  assert.ok(pre.includes('my-guard'), "the user's own PreToolUse hook survives");
  assert.equal(pre.length, 2);
});

test('mergeHookIntoSettings is idempotent', () => {
  const once = mergeHookIntoSettings({});
  assert.equal(once.added, true);
  const twice = mergeHookIntoSettings(once.settings);
  assert.equal(twice.added, false);
  assert.equal(twice.settings.hooks.PreToolUse.length, 1);
});

test('mergeHookIntoSettings tolerates a malformed settings file', () => {
  for (const input of [null, undefined, {}, { hooks: null }, { hooks: { PreToolUse: 'nope' } }]) {
    const { settings } = mergeHookIntoSettings(input);
    assert.equal(settings.hooks.PreToolUse.length, 1);
  }
});

// --- updating -----------------------------------------------------------------

test('re-running is an idempotent update', () => {
  const dir = scratch();
  install(dir);
  const first = readManifest(dir);

  const result = install(dir);
  assert.equal(result.isUpdate, true);
  assert.equal(result.hookAdded, false, 'no duplicate hook entry');
  assert.equal(result.skipped.length, 0);

  const second = readManifest(dir);
  assert.equal(second.installation.installDate, first.installation.installDate, 'install date is kept');
  assert.deepEqual(
    second.files.map((f) => f.sha256),
    first.files.map((f) => f.sha256),
  );

  const settings = readJson(join(dir, '.claude', 'settings.json'));
  assert.equal(settings.hooks.PreToolUse.flatMap((e) => e.hooks).length, 1);
});

test('a locally modified file is detected and left alone', () => {
  const dir = scratch();
  install(dir);

  const edited = join(PAYLOAD_DIR, 'scripts', 'yt.mjs');
  writeFileSync(join(dir, edited), '// my local change\n');

  const result = install(dir);
  assert.ok(result.skipped.includes(edited), 'a modified file must not be clobbered');
  assert.ok(result.modified.includes(edited));
  assert.equal(readFileSync(join(dir, edited), 'utf8'), '// my local change\n');
});

test('a modified file stays flagged on the next run rather than becoming the baseline', () => {
  const dir = scratch();
  install(dir);
  const edited = join(PAYLOAD_DIR, 'scripts', 'yt.mjs');
  writeFileSync(join(dir, edited), '// mine\n');

  install(dir);
  const again = install(dir);
  assert.ok(again.skipped.includes(edited), 'still protected on a third run');
});

test('force overwrites a locally modified file', () => {
  const dir = scratch();
  install(dir);
  const edited = join(PAYLOAD_DIR, 'scripts', 'yt.mjs');
  writeFileSync(join(dir, edited), '// mine\n');

  const result = install(dir, { force: true });
  assert.equal(result.skipped.length, 0);
  assert.ok(result.written.includes(edited));
  assert.notEqual(readFileSync(join(dir, edited), 'utf8'), '// mine\n');
});

test('detectDrift separates clean, modified and missing files', () => {
  const dir = scratch();
  install(dir);
  const manifest = readManifest(dir);

  writeFileSync(join(dir, PAYLOAD_DIR, 'scripts', 'yt.mjs'), 'changed');
  const drift = detectDrift(dir, manifest);

  assert.deepEqual(drift.modified, [join(PAYLOAD_DIR, 'scripts', 'yt.mjs')]);
  assert.equal(drift.missing.length, 0);
  assert.ok(drift.clean.length > 5);
});

test('a file dropped from the distribution is removed on update', () => {
  const dir = scratch();
  install(dir);

  // Pretend the previous version shipped something this one does not. The
  // recorded hash must match the file for it to count as untouched — a stale
  // file the user has since edited is deliberately protected, not deleted.
  const stale = join(PAYLOAD_DIR, 'scripts', 'obsolete.mjs');
  writeFileSync(join(dir, stale), 'old');
  const manifest = readManifest(dir);
  manifest.files.push({
    path: stale,
    sha256: createHash('sha256').update(readFileSync(join(dir, stale))).digest('hex'),
  });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest, null, 2));

  const result = install(dir);
  assert.ok(result.removed.includes(stale));
  assert.ok(!existsSync(join(dir, stale)));
});

test('a stale file the user has edited is protected, not removed', () => {
  const dir = scratch();
  install(dir);

  const stale = join(PAYLOAD_DIR, 'scripts', 'obsolete.mjs');
  writeFileSync(join(dir, stale), 'edited by me');
  const manifest = readManifest(dir);
  // A hash that does not match: the file reads as locally modified.
  manifest.files.push({ path: stale, sha256: 'x'.repeat(64) });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest, null, 2));

  const result = install(dir);
  assert.ok(!result.removed.includes(stale));
  assert.equal(readFileSync(join(dir, stale), 'utf8'), 'edited by me');
});
