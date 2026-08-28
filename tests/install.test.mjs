import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  isOwnedPath,
  ADR_HOOK_COMMAND,
  HOOK_COMMAND,
  SHIPPED_HOOKS,
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

  assert.ok(files.includes(join(PAYLOAD_DIR, 'scripts', 'dev.mjs')));
  assert.ok(files.includes(join(PAYLOAD_DIR, 'lib', 'config.mjs')));
  assert.ok(files.includes(join(PAYLOAD_DIR, 'hooks', 'check-commit-ticket.sh')));
  assert.ok(files.includes(join('.claude', 'skills', 'dev-task', 'SKILL.md')));

  // Repo-only material must never reach a user's project.
  assert.ok(!files.some((f) => f.includes('tests')), 'tests must not be installed');
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.includes('README')));
});

test('every skill is installed under its dev- name', () => {
  const files = [...planFiles(SOURCE_ROOT).keys()];
  for (const skill of ['dev-task', 'dev-bug', 'dev-done', 'dev-init', 'dev-standup', 'dev-ingest-docs', 'dev-adr']) {
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
  assert.ok(existsSync(join(dir, PAYLOAD_DIR, 'scripts', 'dev.mjs')));
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'dev-done', 'SKILL.md')));
  assert.ok(existsSync(join(dir, MANIFEST_PATH)));

  const manifest = readManifest(dir);
  assert.equal(manifest.installation.version, '9.9.9');
  assert.deepEqual(manifest.skills.sort(), [
    'dev-adr', 'dev-bug', 'dev-done', 'dev-ingest-docs', 'dev-init', 'dev-standup', 'dev-task',
  ]);
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
  assert.ok(existsSync(join(dir, PAYLOAD_DIR, 'scripts', 'dev.mjs')));
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

test('every shipped hook is added to settings.json, on its own matcher', () => {
  const dir = scratch();
  const result = install(dir);
  assert.equal(result.hookAdded, true);
  assert.equal(result.addedCommands.length, SHIPPED_HOOKS.length);

  const settings = readJson(join(dir, '.claude', 'settings.json'));
  const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command);
  assert.equal(commands.length, SHIPPED_HOOKS.length);
  assert.ok(commands.some((c) => /_dev-workflow\/hooks\/check-commit-ticket\.sh/.test(c)));
  assert.ok(commands.some((c) => /_dev-workflow\/hooks\/check-adr-immutable\.sh/.test(c)));

  // The matchers are the point: the commit guard sees every Bash call, the ADR
  // guard only file writes. Swapping them would put the slower one on the hot
  // path and stop the other from ever firing.
  const byCommand = new Map(
    settings.hooks.PreToolUse.flatMap((e) => (e.hooks ?? []).map((h) => [h.command, e.matcher])),
  );
  for (const { matcher, command } of SHIPPED_HOOKS) {
    assert.equal(byCommand.get(command), matcher, `wrong matcher for ${command}`);
  }
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
  assert.equal(pre.length, 1 + SHIPPED_HOOKS.length);
});

test('a project installed before a hook existed gains only the missing one', () => {
  // The upgrade path for every project already running an older version: the
  // commit hook is registered, the ADR hook is not, and a re-run must add one
  // entry rather than duplicating the first or rewriting the user's matcher.
  const existing = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] },
      ],
    },
  };
  const { settings, added, addedCommands } = mergeHookIntoSettings(existing);
  assert.equal(added, true);
  assert.deepEqual(addedCommands, [ADR_HOOK_COMMAND]);

  const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks).map((h) => h.command);
  assert.equal(commands.filter((c) => c === HOOK_COMMAND).length, 1, 'no duplicate commit hook');
  assert.ok(commands.includes('my-guard'));
  assert.ok(commands.includes(ADR_HOOK_COMMAND));
});

test('mergeHookIntoSettings is idempotent', () => {
  const once = mergeHookIntoSettings({});
  assert.equal(once.added, true);
  const twice = mergeHookIntoSettings(once.settings);
  assert.equal(twice.added, false);
  assert.deepEqual(twice.addedCommands, []);
  assert.equal(twice.settings.hooks.PreToolUse.length, SHIPPED_HOOKS.length);
});

test('mergeHookIntoSettings tolerates a malformed settings file', () => {
  for (const input of [null, undefined, {}, { hooks: null }, { hooks: { PreToolUse: 'nope' } }]) {
    const { settings } = mergeHookIntoSettings(input);
    assert.equal(settings.hooks.PreToolUse.length, SHIPPED_HOOKS.length);
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
  assert.equal(settings.hooks.PreToolUse.flatMap((e) => e.hooks).length, SHIPPED_HOOKS.length);
});

test('a locally modified file is detected and left alone', () => {
  const dir = scratch();
  install(dir);

  const edited = join(PAYLOAD_DIR, 'scripts', 'dev.mjs');
  writeFileSync(join(dir, edited), '// my local change\n');

  const result = install(dir);
  assert.ok(result.skipped.includes(edited), 'a modified file must not be clobbered');
  assert.ok(result.modified.includes(edited));
  assert.equal(readFileSync(join(dir, edited), 'utf8'), '// my local change\n');
});

test('a modified file stays flagged on the next run rather than becoming the baseline', () => {
  const dir = scratch();
  install(dir);
  const edited = join(PAYLOAD_DIR, 'scripts', 'dev.mjs');
  writeFileSync(join(dir, edited), '// mine\n');

  install(dir);
  const again = install(dir);
  assert.ok(again.skipped.includes(edited), 'still protected on a third run');
});

test('force overwrites a locally modified file', () => {
  const dir = scratch();
  install(dir);
  const edited = join(PAYLOAD_DIR, 'scripts', 'dev.mjs');
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

  writeFileSync(join(dir, PAYLOAD_DIR, 'scripts', 'dev.mjs'), 'changed');
  const drift = detectDrift(dir, manifest);

  assert.deepEqual(drift.modified, [join(PAYLOAD_DIR, 'scripts', 'dev.mjs')]);
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

// --- staying inside our own two roots ----------------------------------------
//
// A project is shared ground: other tools install their own payload directories
// and their own skills next to ours. The installer must be incapable of
// touching any of it, by construction rather than by luck.

test('isOwnedPath accepts only our payload and our namespaced skills', () => {
  assert.equal(isOwnedPath(join(PAYLOAD_DIR, 'scripts', 'dev.mjs')), true);
  assert.equal(isOwnedPath(join('.claude', 'skills', 'dev-task', 'SKILL.md')), true);

  // Another tool's payload, another tool's skills, the user's own files.
  assert.equal(isOwnedPath(join('_other', 'scripts', 'thing.py')), false);
  assert.equal(isOwnedPath(join('.claude', 'skills', 'other-agent', 'SKILL.md')), false);
  assert.equal(isOwnedPath(join('.claude', 'settings.json')), false, 'merged, never rewritten');
  assert.equal(isOwnedPath('README.md'), false);
  assert.equal(isOwnedPath('src/index.ts'), false);
  assert.equal(isOwnedPath(PAYLOAD_DIR), false, 'the root itself is not a file');
});

test('a co-installed tool in the same project is left completely untouched', () => {
  const dir = scratch();

  // A project already using another skill-based tool, laid out the way one is.
  const foreign = {
    [join('_other', 'config.toml')]: 'name = "other"',
    [join('_other', 'scripts', 'run.py')]: 'print("hi")',
    [join('.claude', 'skills', 'other-agent', 'SKILL.md')]: '---\nname: other-agent\n---\n',
    [join('.claude', 'skills', 'other-review', 'SKILL.md')]: '---\nname: other-review\n---\n',
  };
  for (const [rel, body] of Object.entries(foreign)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }

  install(dir);
  install(dir); // and again — the update path is where deletes happen

  for (const [rel, body] of Object.entries(foreign)) {
    assert.equal(readFileSync(join(dir, rel), 'utf8'), body, `${rel} must be untouched`);
  }

  // Our skills sit alongside theirs rather than replacing them.
  const skills = readdirSync(join(dir, '.claude', 'skills')).sort();
  assert.deepEqual(skills, [
    'dev-adr',
    'dev-bug',
    'dev-done',
    'dev-ingest-docs',
    'dev-init',
    'dev-standup',
    'dev-task',
    'other-agent',
    'other-review',
  ]);
});

test('a manifest naming a foreign path cannot delete it', () => {
  // The manifest lives in the user's repo and can be edited or go wrong. It is
  // never trusted as authority to remove a file outside our roots.
  const dir = scratch();
  install(dir);

  const foreign = join('_other', 'precious.toml');
  mkdirSync(dirname(join(dir, foreign)), { recursive: true });
  writeFileSync(join(dir, foreign), 'keep me');

  const manifest = readManifest(dir);
  manifest.files.push({
    path: foreign,
    sha256: createHash('sha256').update('keep me').digest('hex'),
  });
  manifest.files.push({ path: '../escaped.txt', sha256: 'x'.repeat(64) });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest, null, 2));

  const result = install(dir);
  assert.ok(!result.removed.includes(foreign));
  assert.equal(readFileSync(join(dir, foreign), 'utf8'), 'keep me');
});

test('the installer refuses to plan a write outside its roots', () => {
  // A misnamed skill directory in the distribution would otherwise install into
  // someone else's namespace.
  const fakeDist = scratch();
  mkdirSync(join(fakeDist, 'skills', 'not-namespaced'), { recursive: true });
  writeFileSync(join(fakeDist, 'skills', 'not-namespaced', 'SKILL.md'), '---\nname: x\n---\n');

  assert.throws(
    () => installPayload({ sourceRoot: fakeDist, projectDir: scratch(), version: '0.0.0' }),
    /refusing to install/,
  );
});

// --- the non-interactive update path -----------------------------------------
//
// One CLI case, deliberately. `tests/` otherwise exercises libraries, but the
// invariant here is a property of the *process*: `--update` must exit before the
// first prompt. If it regresses, the installer blocks on a closed stdin forever
// and no library test can see it — the timeout below is the assertion.

test('--update installs with no prompts, and --print writes nothing', async () => {
  const dir = scratch();

  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(SOURCE_ROOT, 'bin', 'install.mjs'), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code, signal) => resolve({ code, signal, out }));
    });

  const dry = await run(['--update', '--print', '--dir', dir]);
  assert.equal(dry.signal, null, `--update --print did not exit on its own: ${dry.out}`);
  assert.equal(dry.code, 0, dry.out);
  assert.equal(readdirSync(dir).length, 0, 'a dry run must write nothing at all');

  const real = await run(['--update', '--dir', dir]);
  assert.equal(real.signal, null, `--update did not exit on its own: ${real.out}`);
  assert.equal(real.code, 0, real.out);
  assert.ok(existsSync(join(dir, MANIFEST_PATH)), 'the manifest is what makes the next run an update');
  assert.ok(existsSync(join(dir, PAYLOAD_DIR, 'scripts', 'dev.mjs')));
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'dev-task', 'SKILL.md')));

  // The config is the wizard's business, not the updater's.
  assert.ok(!existsSync(join(dir, '.dev-workflow.json')), '--update must not touch the config');
});
