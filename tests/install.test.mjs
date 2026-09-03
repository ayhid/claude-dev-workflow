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
  PAYLOAD_SOURCES,
  detectDrift,
  installPayload,
  isGeneratedPath,
  isOwnedPath,
  ADR_HOOK_COMMAND,
  HOOK_COMMAND,
  SESSION_HOOK_COMMAND,
  SHIPPED_HOOKS,
  mergeHookIntoSettings,
  planFiles,
  readManifest,
  UPDATE_HOOK_COMMAND,
} from '../bin/lib/payload.mjs';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = () => mkdtempSync(join(tmpdir(), 'ytinstall-'));
const install = (projectDir, opts = {}) =>
  installPayload({ sourceRoot: SOURCE_ROOT, projectDir, version: '9.9.9', ...opts });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * Every hook command in a settings file, across every event.
 *
 * Counting per event stopped being enough once the hooks spanned two of them:
 * an assertion against `hooks.PreToolUse` alone passes just as happily when a
 * hook was registered under the wrong event as when it was registered right.
 */
const allCommands = (settings) =>
  Object.values(settings.hooks ?? {}).flatMap((entries) =>
    (Array.isArray(entries) ? entries : []).flatMap((e) => (e?.hooks ?? []).map((h) => h.command)),
  );

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

test('planFiles never plans a path under artifacts/ — that is per-project generated data', () => {
  // A regression pin, not a red/green pair: PAYLOAD_SOURCES is a hardcoded
  // literal that cannot produce 'artifacts' as its second path segment, so
  // this already holds. It is worth a test anyway, because isGeneratedPath
  // (the guard the delete pass relies on) is defined against the same
  // literal string — if the two ever drift, this is what would catch it.
  const files = [...planFiles(SOURCE_ROOT).keys()];
  assert.ok(!files.some((f) => isGeneratedPath(f)), 'no planned path is generated data');
  assert.ok(!PAYLOAD_SOURCES.includes('artifacts'), "'artifacts' must never become a shipped source");
});

test('every skill is installed under its dev- name', () => {
  const files = [...planFiles(SOURCE_ROOT).keys()];
  for (const skill of ['dev-task', 'dev-bug', 'dev-done', 'dev-init', 'dev-standup', 'dev-ingest-docs', 'dev-docs-init', 'dev-adr', 'dev-tdd', 'dev-review', 'dev-lint-rules']) {
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
    'dev-adr', 'dev-bug', 'dev-docs-init', 'dev-done', 'dev-ingest-docs', 'dev-init', 'dev-lint-rules', 'dev-review', 'dev-standup', 'dev-task', 'dev-tdd',
  ]);
  assert.ok(manifest.files.length > 10);
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));

  // The third root (#91): the agent definitions land where Claude Code reads them.
  assert.ok(existsSync(join(dir, '.claude', 'agents', 'dev-reader.md')));
  assert.ok(existsSync(join(dir, '.claude', 'agents', 'dev-reviewer.md')));
  assert.ok(manifest.files.some((f) => f.path === join('.claude', 'agents', 'dev-reader.md')));
});

test('an agent dropped from the distribution is removed on update, and a foreign agent is not (#91)', () => {
  const dir = scratch();
  install(dir);

  const dropped = join('.claude', 'agents', 'dev-old.md');
  writeFileSync(join(dir, dropped), '---\nname: dev-old\n---\n# old\n');
  const manifest = readManifest(dir);
  manifest.files.push({ path: dropped, sha256: createHash('sha256').update(readFileSync(join(dir, dropped))).digest('hex') });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, '.claude', 'agents', 'other-tool.md'), '---\nname: other-tool\n---\n# theirs\n');

  const result = install(dir);
  assert.ok(result.removed.includes(dropped));
  assert.ok(!existsSync(join(dir, dropped)));
  assert.ok(existsSync(join(dir, '.claude', 'agents', 'other-tool.md')), 'shared ground');
  assert.ok(existsSync(join(dir, '.claude', 'agents', 'dev-reader.md')));
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

test('every shipped hook is added to settings.json, on its own event and matcher', () => {
  const dir = scratch();
  const result = install(dir);
  assert.equal(result.hookAdded, true);
  assert.equal(result.addedCommands.length, SHIPPED_HOOKS.length);

  const settings = readJson(join(dir, '.claude', 'settings.json'));
  const commands = allCommands(settings);
  assert.equal(commands.length, SHIPPED_HOOKS.length);
  assert.ok(commands.some((c) => /_dev-workflow\/hooks\/check-commit-ticket\.sh/.test(c)));
  assert.ok(commands.some((c) => /_dev-workflow\/hooks\/check-adr-immutable\.sh/.test(c)));
  assert.ok(commands.some((c) => /_dev-workflow\/hooks\/session-standup\.mjs/.test(c)));

  // The event and the matcher are both the point. The commit guard sees every
  // Bash call, the ADR guard only file writes, and the greeting fires once per
  // session on no tool at all. Registering any of them under another event, or
  // swapping the two matchers, silently stops it doing its job.
  for (const { event, matcher, command } of SHIPPED_HOOKS) {
    const entry = (settings.hooks[event] ?? []).find((e) =>
      (e.hooks ?? []).some((h) => h.command === command),
    );
    assert.ok(entry, `${command} is not registered under ${event}`);
    assert.equal(entry.matcher, matcher || undefined, `wrong matcher for ${command}`);
  }
});

test('a matcherless hook is written without a matcher key', () => {
  // SessionStart guards no tool. An empty matcher would not be the same as no
  // matcher — it is a pattern that matches nothing.
  const { settings } = mergeHookIntoSettings({});
  for (const entry of settings.hooks.SessionStart ?? []) {
    assert.ok(!('matcher' in entry), 'SessionStart entries carry no matcher key');
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
        SessionStart: [{ hooks: [{ type: 'command', command: 'my-greeting' }] }],
      },
      permissions: { allow: ['Bash(ls:*)'] },
    }),
  );

  install(dir);
  const settings = readJson(join(dir, '.claude', 'settings.json'));

  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated keys survive');
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'my-formatter');

  const all = allCommands(settings);
  assert.ok(all.includes('my-guard'), "the user's own PreToolUse hook survives");
  assert.ok(all.includes('my-greeting'), "the user's own SessionStart hook survives");
  assert.equal(all.length, 3 + SHIPPED_HOOKS.length);
});

test('a project installed before a hook existed gains only the missing ones', () => {
  // The upgrade path for every project already running an older version: the
  // commit hook is registered, the other three are not, and a re-run must add
  // them rather than duplicating the first or rewriting the user's matcher.
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
  assert.deepEqual(addedCommands, [ADR_HOOK_COMMAND, SESSION_HOOK_COMMAND, UPDATE_HOOK_COMMAND]);

  const commands = allCommands(settings);
  assert.equal(commands.filter((c) => c === HOOK_COMMAND).length, 1, 'no duplicate commit hook');
  assert.ok(commands.includes('my-guard'));
  assert.ok(commands.includes(ADR_HOOK_COMMAND));
  assert.ok(commands.includes(SESSION_HOOK_COMMAND));
});

test('mergeHookIntoSettings is idempotent', () => {
  const once = mergeHookIntoSettings({});
  assert.equal(once.added, true);
  const twice = mergeHookIntoSettings(once.settings);
  assert.equal(twice.added, false);
  assert.deepEqual(twice.addedCommands, []);
  assert.equal(allCommands(twice.settings).length, SHIPPED_HOOKS.length);
});

test('mergeHookIntoSettings tolerates a malformed settings file', () => {
  // Every one of these has been a real settings.json at some point: a
  // hand-edited file, a partially written one, a key set to the wrong type.
  const inputs = [
    null,
    undefined,
    {},
    { hooks: null },
    { hooks: { PreToolUse: 'nope' } },
    { hooks: { SessionStart: 'nope' } },
    { hooks: { PreToolUse: [null, { hooks: null }] } },
  ];
  for (const input of inputs) {
    const { settings } = mergeHookIntoSettings(input);
    assert.equal(allCommands(settings).length, SHIPPED_HOOKS.length, `bad merge for ${JSON.stringify(input)}`);
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
  assert.equal(allCommands(settings).length, SHIPPED_HOOKS.length);
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

test('isOwnedPath accepts exactly our namespaced agent files, the third root (#91)', () => {
  assert.equal(isOwnedPath(join('.claude', 'agents', 'dev-reader.md')), true);
  assert.equal(isOwnedPath(join('.claude', 'agents', 'other.md')), false, "someone else's agent");
  assert.equal(isOwnedPath(join('.claude', 'agents', 'dev-x', 'nested.md')), false, 'an agent is one file, not a directory');
  assert.equal(isOwnedPath(join('.claude', 'agents', 'dev-')), false, 'the prefix alone names nothing');
  assert.equal(isOwnedPath(join('.claude', 'agents', 'dev-reader.txt')), false, 'Claude Code reads .md only');
  assert.equal(isOwnedPath(join('.claude', 'agents')), false, 'the directory is shared ground');
});

test('planFiles maps agents/<name>.md onto .claude/agents/<name>.md, and nothing else moves', () => {
  const files = planFiles(SOURCE_ROOT);
  assert.equal(files.get(join('.claude', 'agents', 'dev-reader.md')), join(SOURCE_ROOT, 'agents', 'dev-reader.md'));
  assert.equal(files.get(join('.claude', 'agents', 'dev-reviewer.md')), join(SOURCE_ROOT, 'agents', 'dev-reviewer.md'));
  for (const planned of files.keys()) {
    assert.ok(isOwnedPath(planned), `${planned} is planned but not owned`);
    if (planned.startsWith(join('.claude', 'agents'))) assert.match(planned, /^\.claude\/agents\/dev-[^/]+\.md$/);
  }
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
    'dev-docs-init',
    'dev-done',
    'dev-ingest-docs',
    'dev-init',
    'dev-lint-rules',
    'dev-review',
    'dev-standup',
    'dev-task',
    'dev-tdd',
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

test('a generated artifact under _dev-workflow/artifacts/ survives even if the manifest names it', () => {
  // Unlike a foreign path, this one *is* under our owned root, so isOwnedPath
  // offers no protection — the only thing to rely on is an explicit exclusion
  // for artifacts/. Simulates the failure mode a stray merge of ingest's own
  // bookkeeping into the manifest would produce: a hash-matching entry for
  // generated content that planFiles never itself emits.
  const dir = scratch();
  install(dir);

  const artifact = join(PAYLOAD_DIR, 'artifacts', 'documentation', 'map.md');
  mkdirSync(dirname(join(dir, artifact)), { recursive: true });
  writeFileSync(join(dir, artifact), '# generated map\n');

  const manifest = readManifest(dir);
  manifest.files.push({
    path: artifact,
    sha256: createHash('sha256').update('# generated map\n').digest('hex'),
  });
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest, null, 2));

  const result = install(dir);
  assert.ok(!result.removed.includes(artifact));
  assert.equal(readFileSync(join(dir, artifact), 'utf8'), '# generated map\n');
});

test('isGeneratedPath still matches an artifacts path carrying a literal "." segment', () => {
  // isOwnedPath rejects '..' and empty segments but not a bare '.' one, so a
  // hand-edited manifest entry like this passes it through to isGeneratedPath —
  // which must not then miss the artifacts/ prefix because of the stray '.'.
  assert.ok(isGeneratedPath(join(PAYLOAD_DIR, '.', 'artifacts', 'documentation', 'map.md')));
  assert.ok(isGeneratedPath(`${PAYLOAD_DIR}/./artifacts/documentation/map.md`));
});

test('isGeneratedPath rejects a malformed path rather than misclassifying it', () => {
  // Unlike the delete pass, detectDrift calls isGeneratedPath with no
  // isOwnedPath gate ahead of it, so a traversal or double-separator segment
  // must not slip past the artifacts/ prefix check on its own.
  assert.ok(!isGeneratedPath(`${PAYLOAD_DIR}/artifacts/../../etc/passwd`));
  assert.ok(!isGeneratedPath(`${PAYLOAD_DIR}//artifacts/x`));
  assert.ok(!isGeneratedPath(`/${PAYLOAD_DIR}/artifacts/x`));
});

test('detectDrift never reports a generated artifact as installer drift', () => {
  // Same failure mode as the survival test above, from the read side: a
  // manifest entry under artifacts/ must not show up as modified, missing or
  // clean installer drift, whether or not its hash still matches the file on
  // disk — it is not installer content in the first place.
  const dir = scratch();
  install(dir);

  const artifact = join(PAYLOAD_DIR, 'artifacts', 'documentation', 'map.md');
  const manifest = readManifest(dir);
  manifest.files.push({ path: artifact, sha256: 'x'.repeat(64) });

  const drift = detectDrift(dir, manifest);
  assert.ok(!drift.modified.includes(artifact));
  assert.ok(!drift.missing.includes(artifact));
  assert.ok(!drift.clean.includes(artifact));
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

// --- what express mode does to the config ------------------------------------
//
// Two more process-level cases, for the same reason as the one above: whether
// the installer prompts, and whether it exits on its own, cannot be observed
// from a library. Both run with stdin closed, which is the no-TTY path — the
// one that must ask nothing.

const runInstaller = (args) =>
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

/** A config with every key the registry knows about, in a formatting of its own. */
const completeConfig = () =>
  JSON.stringify(
    {
      provider: 'github',
      github: { repo: 'acme/api', labels: { 'In Progress': 'status: in progress', Done: 'status: done' } },
      language: 'English',
      states: { start: 'In Progress', review: 'In Review', done: 'Done', ladder: ['Backlog', 'In Progress', 'Done'] },
      branch: { pattern: '<ID>-<slug>', base: 'main', mode: 'worktree' },
      delivery: { mode: 'pr' },
      commit: { pattern: 'type(scope): description (<ID>)', position: 'suffix', noTicketEscape: 'chore(no-ticket)' },
    },
    null,
    4,
  ) + '\n';

test('an express update leaves a complete config byte-identical', async () => {
  const dir = scratch();
  const before = completeConfig();
  writeFileSync(join(dir, '.dev-workflow.json'), before);

  const real = await runInstaller(['--update', '--dir', dir]);
  assert.equal(real.signal, null, `--update did not exit on its own: ${real.out}`);
  assert.equal(real.code, 0, real.out);

  // Not "equivalent JSON": the same bytes. Nothing is rewritten, reordered or
  // reindented, because with nothing missing nothing is written at all.
  assert.equal(readFileSync(join(dir, '.dev-workflow.json'), 'utf8'), before);
});

test('an express update adds a key the config does not have, and says so', async () => {
  const dir = scratch();
  const config = JSON.parse(completeConfig());
  delete config.language;
  delete config.commit.noTicketEscape;
  writeFileSync(join(dir, '.dev-workflow.json'), JSON.stringify(config, null, 2) + '\n');

  const real = await runInstaller(['--update', '--dir', dir]);
  assert.equal(real.signal, null, `--update blocked on a prompt with no TTY: ${real.out}`);
  assert.equal(real.code, 0, real.out);

  const written = readJson(join(dir, '.dev-workflow.json'));
  assert.equal(written.language, 'English');
  assert.equal(written.commit.noTicketEscape, 'chore(no-ticket)');

  // The choice has to be visible in the log, since nobody was asked.
  assert.match(real.out, /language = English/);
  assert.match(real.out, /commit\.noTicketEscape = chore\(no-ticket\)/);

  // Every answer that was already there survives, in the order it was in.
  assert.deepEqual(written.states, JSON.parse(completeConfig()).states);
  assert.equal(written.branch.pattern, '<ID>-<slug>');
  assert.deepEqual(Object.keys(written.commit), ['pattern', 'position', 'noTicketEscape']);
});

test('an express dry run reports the new keys and writes nothing', async () => {
  const dir = scratch();
  const config = JSON.parse(completeConfig());
  delete config.language;
  const before = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(join(dir, '.dev-workflow.json'), before);

  const dry = await runInstaller(['--update', '--print', '--dir', dir]);
  assert.equal(dry.signal, null, `--update --print did not exit on its own: ${dry.out}`);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /language = English/);
  assert.equal(readFileSync(join(dir, '.dev-workflow.json'), 'utf8'), before);
});

// --- subcommands, through the spawned binary --------------------------------------

test('version prints the package version and exits 0', async () => {
  const { version } = JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf8'));
  const r = await runInstaller(['version']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), version);
});

test('help names the subcommands and the three install routes', async () => {
  for (const args of [['help'], ['--help']]) {
    const r = await runInstaller(args);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /init/);
    assert.match(r.out, /update/);
    assert.match(r.out, /brew install/);
    assert.match(r.out, /npm install -g/);
    assert.match(r.out, /npx claude-dev-workflow@latest/);
  }
});

test('an unknown subcommand prints the usage and exits non-zero, with stdin closed', async () => {
  const r = await runInstaller(['instal']);
  assert.notEqual(r.code, 0);
  assert.equal(r.signal, null, 'must not block on a prompt');
  assert.match(r.out, /instal/);
  assert.match(r.out, /init, update, version, help/);
});

test('update --print is the express path under its subcommand name, and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-sub-'));
  const r = await runInstaller(['update', '--print', '--dir', dir]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.signal, null, 'update blocked on a prompt with no TTY');
  assert.match(r.out, /Planned only/);
  assert.ok(!existsSync(join(dir, '_dev-workflow')), 'a dry run writes nothing');
});

// --- dw: the short spelling, and an update that knows what version it is ------------

test('dw is a second name for the same binary, in the package and the formula', () => {
  const pkg = JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.dw, pkg.bin['claude-dev-workflow'], 'one file, two names');
  const formula = readFileSync(join(SOURCE_ROOT, 'Formula', 'claude-dev-workflow.rb'), 'utf8');
  assert.match(formula, /bin\.install_symlink Dir\["#\{libexec\}\/bin\/\*"\]/, 'the formula links every bin, so dw comes with it');
  assert.match(formula, /dw version/, 'and its test proves the alias answers');
});

test('update says which version the project is on and which it is getting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-upd-'));
  const { version } = JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf8'));
  const first = await runInstaller(['update', '--dir', dir]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(`v${version.replace(/\\./g, '\\\\.')} in `));

  // Age the manifest, then update again: the report names both versions.
  const manifestPath = join(dir, '_dev-workflow', '_config', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.installation.version = '0.9.0';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const again = await runInstaller(['update', '--print', '--dir', dir]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, new RegExp(`v0\\.9\\.0 → v${version.replace(/\\./g, '\\\\.')}`));
});

test('update refuses to downgrade a project below what a newer binary installed, unless forced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwf-down-'));
  await runInstaller(['update', '--dir', dir]);
  const manifestPath = join(dir, '_dev-workflow', '_config', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.installation.version = '99.0.0';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const refused = await runInstaller(['update', '--dir', dir]);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.signal, null);
  assert.match(refused.out, /99\.0\.0/);
  assert.match(refused.out, /brew upgrade claude-dev-workflow|npm update -g claude-dev-workflow/);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).installation.version, '99.0.0', 'nothing written');

  const forced = await runInstaller(['update', '--force', '--dir', dir]);
  assert.equal(forced.code, 0, forced.out);
  assert.notEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).installation.version, '99.0.0');
});
