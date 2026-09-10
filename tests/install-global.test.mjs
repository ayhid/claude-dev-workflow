/**
 * Routing the payload: the runtime to the machine, the enforcement to the project.
 *
 * A global install splits one file set across two roots. `lib/`, `scripts/` and
 * the two Node hooks — which `import '../lib/…'` and so cannot resolve it across
 * roots — land under `$HOME/.claude/dev-workflow`; the skills, the agents and
 * the two bash guards stay in the project, because a guard that is not there
 * exits 127 and enforcement disappears from a fresh clone without a word.
 *
 * Every install here runs for real into a temporary project with a temporary
 * `$HOME`, passed as `env` rather than set on `process.env`. A dry run proves
 * nothing about a write path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { GLOBAL_PAYLOAD_DIR, sha256 } from '../lib/manifest.mjs';
import { AGENTS_DIR, MANIFEST_PATH, PAYLOAD_DIR, SKILLS_DIR, installPayload, isOwnedPath } from '../bin/lib/payload.mjs';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

/** Every file under `dir`, relative to it, sorted. Empty when `dir` does not exist. */
const filesUnder = (dir, base = dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, base, out);
    else out.push(relative(base, full));
  }
  return out.sort();
};

/** A real global install into a fresh project, with a fresh `$HOME`. */
const globalInstall = ({ sourceRoot = SOURCE_ROOT, ...opts } = {}) => {
  const project = tempDir('dw-global-project-');
  const home = tempDir('dw-global-home-');
  const result = installPayload({ sourceRoot, projectDir: project, version: '9.9.9', mode: 'global', env: { HOME: home }, ...opts });
  return { project, home, machine: join(home, GLOBAL_PAYLOAD_DIR), result };
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The skill files, agent files and bash guards the distribution ships, as project-relative paths. */
const shippedProjectSide = () => [
  ...filesUnder(join(SOURCE_ROOT, 'skills')).map((rel) => join(SKILLS_DIR, rel)),
  ...readdirSync(join(SOURCE_ROOT, 'agents')).filter((n) => n.endsWith('.md')).map((n) => join(AGENTS_DIR, n)),
  join(PAYLOAD_DIR, 'hooks', 'check-adr-immutable.sh'),
  join(PAYLOAD_DIR, 'hooks', 'check-commit-ticket.sh'),
].sort();

// --- AC2: the runtime lands on the machine, and not in the project ------------

test('AC2: a global install writes lib, scripts, the two Node hooks and a manifest under $HOME/.claude/dev-workflow', () => {
  const { machine } = globalInstall();

  for (const rel of ['lib', 'scripts']) {
    const shipped = filesUnder(join(SOURCE_ROOT, rel));
    assert.ok(shipped.length > 0);
    assert.deepEqual(filesUnder(join(machine, rel)), shipped, `every file of ${rel}/ lands on the machine`);
  }
  // The Node hooks follow lib/: they import '../lib/config.mjs' relatively. The
  // bash guards do not come with them.
  assert.deepEqual(filesUnder(join(machine, 'hooks')), ['session-standup.mjs', 'session-updatecheck.mjs']);
  assert.ok(existsSync(join(machine, '_config', 'manifest.json')));
});

test('AC2: the machine manifest records exactly the machine files, relative to the machine root', () => {
  const { machine } = globalInstall();
  const manifest = readJson(join(machine, '_config', 'manifest.json'));

  assert.equal(manifest.installation.version, '9.9.9');
  const recorded = manifest.files.map((f) => f.path).sort();
  const onDisk = filesUnder(machine).filter((rel) => rel !== join('_config', 'manifest.json'));
  assert.deepEqual(recorded, onDisk);
  for (const { path, sha256: hash } of manifest.files) {
    assert.equal(hash, sha256(readFileSync(join(machine, path))), `${path} is recorded with its real hash`);
  }
});

test('AC2: a global install writes no lib, no scripts and no Node hook into the project', () => {
  const { project } = globalInstall();

  assert.deepEqual(filesUnder(join(project, PAYLOAD_DIR, 'lib')), []);
  assert.deepEqual(filesUnder(join(project, PAYLOAD_DIR, 'scripts')), []);
  assert.deepEqual(filesUnder(join(project, PAYLOAD_DIR, 'hooks')).filter((n) => n.endsWith('.mjs')), []);
  assert.deepEqual(filesUnder(join(project, 'lib')), [], 'nor at the top level');
});

// --- AC3: the skills, the agents and the guards stay in the project -----------

test('AC3: a global install writes every skill, every agent and both bash guards into the project', () => {
  const { project } = globalInstall();

  for (const rel of shippedProjectSide()) {
    assert.ok(existsSync(join(project, rel)), `${rel} is in the project`);
  }
  for (const guard of ['check-commit-ticket.sh', 'check-adr-immutable.sh']) {
    assert.ok(statSync(join(project, PAYLOAD_DIR, 'hooks', guard)).mode & 0o111, `${guard} stays executable`);
  }
});

test('AC3: the project manifest records the project files and nothing of the machine', () => {
  const { project, machine } = globalInstall();
  const manifest = readJson(join(project, MANIFEST_PATH));

  assert.equal(manifest.installation.version, '9.9.9');
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), shippedProjectSide());
  for (const { path, sha256: hash } of manifest.files) {
    assert.equal(hash, sha256(readFileSync(join(project, path))), `${path} is recorded with its real hash`);
  }
  assert.ok(manifest.skills.includes('dev-task'));

  const machineRecorded = readJson(join(machine, '_config', 'manifest.json')).files.map((f) => f.path);
  assert.ok(!machineRecorded.some((p) => p.startsWith(SKILLS_DIR) || p.startsWith(AGENTS_DIR) || p.endsWith('.sh')));
});

// --- AC6, the other half: a planned write outside the roots still throws ------

test('AC6: a global install from a distribution with an unowned path throws, and writes nothing anywhere', () => {
  // A regression pin rather than a red: the project-side check already threw.
  // What it adds is that the refusal still comes before the first machine write.
  const fakeDist = tempDir('dw-global-dist-');
  mkdirSync(join(fakeDist, 'lib'), { recursive: true });
  writeFileSync(join(fakeDist, 'lib', 'x.mjs'), 'export {};\n');
  mkdirSync(join(fakeDist, 'skills', 'not-namespaced'), { recursive: true });
  writeFileSync(join(fakeDist, 'skills', 'not-namespaced', 'SKILL.md'), '---\nname: x\n---\n');

  const project = tempDir('dw-global-project-');
  const home = tempDir('dw-global-home-');
  assert.throws(
    () => installPayload({ sourceRoot: fakeDist, projectDir: project, version: '0.0.0', mode: 'global', env: { HOME: home } }),
    /refusing to install/,
  );
  assert.deepEqual(readdirSync(home), [], 'nothing on the machine');
  assert.deepEqual(readdirSync(project), [], 'nothing in the project');
});

// --- AC6: the boundary admits the machine root, and nothing else --------------

const MACHINE = { root: 'machine' };

test('AC6: isOwnedPath admits the machine root when asked about it', () => {
  assert.equal(isOwnedPath(join('lib', 'config.mjs'), MACHINE), true);
  assert.equal(isOwnedPath(join('scripts', 'dev.mjs'), MACHINE), true);
  assert.equal(isOwnedPath(join('hooks', 'session-standup.mjs'), MACHINE), true);
  assert.equal(isOwnedPath(join('_config', 'manifest.json'), MACHINE), true);
});

test('AC6: the three project roots are still admitted, with or without naming the base', () => {
  for (const base of [undefined, {}, { root: 'project' }]) {
    assert.equal(isOwnedPath(join(PAYLOAD_DIR, 'hooks', 'check-commit-ticket.sh'), base), true);
    assert.equal(isOwnedPath(join('.claude', 'skills', 'dev-task', 'SKILL.md'), base), true);
    assert.equal(isOwnedPath(join('.claude', 'agents', 'dev-reader.md'), base), true);
  }
});

test('AC6: everything else is refused on the machine root, traversal included', () => {
  for (const rel of ['', '.', '..', '../x', join('lib', '..', '..', 'x'), '/etc/passwd', 'lib//x', null, 42]) {
    assert.equal(isOwnedPath(rel, MACHINE), false, `${JSON.stringify(rel)} must not be ours on the machine`);
  }
});

test('AC6: a machine-relative path is not ours inside the project, and an unknown base owns nothing', () => {
  // The project boundary is not loosened by the machine one: `lib/config.mjs`
  // at a project's top level is the user's file.
  assert.equal(isOwnedPath(join('lib', 'config.mjs')), false);
  assert.equal(isOwnedPath(join('lib', 'config.mjs'), { root: 'project' }), false);
  assert.equal(isOwnedPath(join('lib', 'config.mjs'), { root: 'elsewhere' }), false);
});

test('AC6: the root is an option, so isOwnedPath still works passed straight to an array method', () => {
  // `tools/check-payload.mjs` calls `paths.some(isOwnedPath)`, which hands the
  // index over as the second argument. A positional root would read index 0 as
  // an unknown root and disown every file.
  assert.equal([join(PAYLOAD_DIR, 'lib', 'config.mjs')].some(isOwnedPath), true);
  assert.deepEqual(['README.md', join('.claude', 'skills', 'dev-task', 'SKILL.md')].filter(isOwnedPath), [
    join('.claude', 'skills', 'dev-task', 'SKILL.md'),
  ]);
});
