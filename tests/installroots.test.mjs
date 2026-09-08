/**
 * Where an install actually puts things — one resolver, two modes.
 *
 * `local` is what every install has always done: the runtime under the
 * project's `_dev-workflow/`, the skills and agents under its `.claude/`.
 * `global` moves the runtime alone onto the machine and leaves the skills, the
 * agents and the guards where they were, so a fresh clone still enforces.
 *
 * The environment is an argument rather than `process.env`, and this file is
 * the reason: every test here needs `$HOME` pointed somewhere temporary, and a
 * resolver that read the real one could only be tested by mutating it globally.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENTS_DIR,
  GLOBAL_PAYLOAD_DIR,
  INSTALL_MODES,
  MANIFEST_PATH,
  PAYLOAD_DIR,
  PAYLOAD_ROOT_TOKEN,
  SKILLS_DIR,
  resolveInstallRoots,
} from '../lib/manifest.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT = '/tmp/proj';
const HOME = '/tmp/home';

test('local resolves everything under the project, exactly as it always has', () => {
  const r = resolveInstallRoots({ projectDir: PROJECT, mode: 'local', env: { HOME } });
  assert.equal(r.mode, 'local');
  assert.equal(r.projectRoot, PROJECT);
  assert.equal(r.payloadRoot, join(PROJECT, PAYLOAD_DIR));
  assert.equal(r.skillsRoot, join(PROJECT, SKILLS_DIR));
  assert.equal(r.agentsRoot, join(PROJECT, AGENTS_DIR));
});

test('local is the default mode: an absent mode is not a reason to guess', () => {
  const r = resolveInstallRoots({ projectDir: PROJECT, env: { HOME } });
  assert.equal(r.mode, 'local');
  assert.equal(r.payloadRoot, join(PROJECT, PAYLOAD_DIR));
});

test('global moves the runtime onto the machine and leaves the rest in the project', () => {
  const r = resolveInstallRoots({ projectDir: PROJECT, mode: 'global', env: { HOME } });
  assert.equal(r.mode, 'global');
  assert.equal(r.payloadRoot, join(HOME, '.claude', 'dev-workflow'));
  // The skills, the agents and the guards stay project-side: a guard that is
  // missing exits 127, so enforcement would disappear from a fresh clone.
  assert.equal(r.skillsRoot, join(PROJECT, SKILLS_DIR));
  assert.equal(r.agentsRoot, join(PROJECT, AGENTS_DIR));
  assert.equal(r.projectRoot, PROJECT);
});

test('a split install has two manifests, one per root', () => {
  const g = resolveInstallRoots({ projectDir: PROJECT, mode: 'global', env: { HOME } });
  assert.equal(g.payloadManifest, join(HOME, '.claude', 'dev-workflow', '_config', 'manifest.json'));
  assert.equal(g.projectManifest, join(PROJECT, MANIFEST_PATH));
  assert.notEqual(g.payloadManifest, g.projectManifest);

  // Local is the degenerate case of the same shape: one root, so one file.
  const l = resolveInstallRoots({ projectDir: PROJECT, mode: 'local', env: { HOME } });
  assert.equal(l.payloadManifest, join(PROJECT, MANIFEST_PATH));
  assert.equal(l.projectManifest, l.payloadManifest);
});

test('the environment is the argument, never process.env', () => {
  const a = resolveInstallRoots({ projectDir: PROJECT, mode: 'global', env: { HOME: '/tmp/a' } });
  const b = resolveInstallRoots({ projectDir: PROJECT, mode: 'global', env: { HOME: '/tmp/b' } });
  assert.equal(a.payloadRoot, join('/tmp/a', '.claude', 'dev-workflow'));
  assert.equal(b.payloadRoot, join('/tmp/b', '.claude', 'dev-workflow'));
  assert.notEqual(a.payloadRoot, process.env.HOME);
});

test('USERPROFILE stands in for HOME where that is what the shell sets', () => {
  const r = resolveInstallRoots({ projectDir: PROJECT, mode: 'global', env: { USERPROFILE: '/tmp/win' } });
  assert.equal(r.payloadRoot, join('/tmp/win', '.claude', 'dev-workflow'));
});

test('a relative project directory is resolved to an absolute one', () => {
  const r = resolveInstallRoots({ projectDir: '.', mode: 'local', env: { HOME } });
  assert.equal(r.projectRoot, process.cwd());
  assert.equal(r.payloadRoot, join(process.cwd(), PAYLOAD_DIR));
});

test('global with no home is an error naming the variable, not a path under undefined', () => {
  assert.throws(
    () => resolveInstallRoots({ projectDir: PROJECT, mode: 'global', env: {} }),
    /HOME/,
  );
});

test('an unknown mode is refused rather than treated as local', () => {
  // Rule 2: a guess that is usually right is worse than an error, because the
  // times it is wrong are silent.
  assert.throws(() => resolveInstallRoots({ projectDir: PROJECT, mode: 'globl', env: { HOME } }), /globl/);
  assert.deepEqual(INSTALL_MODES, ['local', 'global']);
});

test('a project directory is required', () => {
  assert.throws(() => resolveInstallRoots({ mode: 'local', env: { HOME } }), /projectDir/);
});

test('the skills token is spelled once, for both sides of the substitution', () => {
  // The skill sources carry this where the `dev.mjs` invocation is spelled, and
  // the installer replaces it with the mode's own root. Two spellings of it
  // would mean a skill nobody substitutes, failing on its first command.
  assert.equal(typeof PAYLOAD_ROOT_TOKEN, 'string');
  assert.match(PAYLOAD_ROOT_TOKEN, /^\{\{[A-Z_]+\}\}$/, 'a token no shell or Markdown reader will mistake for content');
});

// --- AC10: one spelling of the machine root, and it lives here ---------------

/** Every `.mjs` under `dir`, recursively. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...sources(abs));
    else if (name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

/**
 * Both spellings of the machine root: the literal path, and the
 * `join('.claude', 'dev-workflow')` form that produces it without ever
 * containing it.
 *
 * The lookahead is not slack. `.claude/dev-workflow.json` is the alternate
 * *config file* `CONFIG_FILES` has always listed — a different thing that
 * happens to share a prefix — and matching it would make this fail on a file
 * that spells no root at all.
 */
const LITERAL = /\.claude[/\\]dev-workflow(?![\w.-])/;
const JOINED = /['"]\.claude['"]\s*,\s*['"]dev-workflow['"]/;

test('the sweep below can actually see a second spelling', () => {
  // Otherwise the lookahead could narrow it to nothing and the sweep would
  // pass by never matching anything at all.
  assert.ok(LITERAL.test(`const root = join(home, '.claude/dev-workflow');`));
  assert.ok(JOINED.test(`const root = join(home, '.claude', 'dev-workflow');`));
  assert.ok(!LITERAL.test(`join('.claude', 'dev-workflow.json')`), 'the config file is not the root');
  assert.ok(!JOINED.test(`join('.claude', 'dev-workflow.json')`), 'the config file is not the root');
});

test('the machine payload root is spelled in lib/manifest.mjs and nowhere else', () => {
  const literal = LITERAL;
  const joined = JOINED;
  const home = join('lib', 'manifest.mjs');

  const offenders = [];
  for (const abs of [...sources(join(REPO_ROOT, 'bin')), ...sources(join(REPO_ROOT, 'lib'))]) {
    const rel = relative(REPO_ROOT, abs);
    if (rel === home) continue;
    const text = readFileSync(abs, 'utf8');
    if (literal.test(text) || joined.test(text)) offenders.push(rel);
  }

  assert.deepEqual(offenders, [], `spell the machine root once, in ${home}, and import it`);
});

test('and it is spelled there, so the sweep above is not vacuous', () => {
  const text = readFileSync(join(REPO_ROOT, 'lib', 'manifest.mjs'), 'utf8');
  assert.ok(LITERAL.test(text) || JOINED.test(text));
  assert.equal(GLOBAL_PAYLOAD_DIR, '.claude/dev-workflow');
});
