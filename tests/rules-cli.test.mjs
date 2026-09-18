/**
 * `dev.mjs rules`, end to end, without a linter anywhere near it.
 *
 * The command is the only part of this feature that spawns anything, so it is
 * the only part that can be wrong about a tool it cannot reach. Its runner is
 * injected for exactly that reason: every answer a real ESLint could give —
 * absent, broken, slow, fine — is a fixture here rather than a machine someone
 * has to have set up.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { parseArgs, run } from '../scripts/cmd/rules.mjs';
import { BIOME, MONO, NO_STACK, TS_BARE, TS_FULL } from './fixtures/stacks.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'dw-rules-'));

/** Write a fixture out as a real directory, since the command reads from disk. */
function project(fixture, config = {}) {
  const dir = scratch();
  writeFileSync(join(dir, '.dev-workflow.json'), JSON.stringify({ provider: 'github', ...config }));
  for (const path of fixture.files) {
    const body = fixture.tree[path] ?? '';
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

/** A runner answering `git ls-files` from the fixture and every spawn from a table. */
const runnerFor = (fixture, answers = {}) => async (cmd, args) => {
  if (cmd === 'git') return { ok: true, code: 0, stdout: fixture.files.join('\n'), stderr: '' };
  const key = [cmd, ...args].join(' ');
  const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1];
  return answer ?? { ok: false, code: 127, stdout: '', stderr: `${cmd}: command not found` };
};

/** Run the command, capturing what it wrote. */
async function capture(dir, argv, runner) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
  const previous = process.env.YOUTRACK_CONFIG_DIR;
  process.env.YOUTRACK_CONFIG_DIR = dir;
  try {
    const code = await run(argv, { run: runner });
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = original;
    if (previous === undefined) delete process.env.YOUTRACK_CONFIG_DIR;
    else process.env.YOUTRACK_CONFIG_DIR = previous;
  }
}

const printConfig = (rules, extra = {}) => ({
  ok: true,
  code: 0,
  stdout: JSON.stringify({ rules, ...extra }),
  stderr: '',
});

test('--doctrine is a flag, and an unknown one is still refused', () => {
  assert.equal(parseArgs(['--doctrine']).doctrine, true);
  assert.equal(parseArgs([]).doctrine, false);
  assert.throws(() => parseArgs(['--doctrin']), /unknown argument/);
});

test('without --doctrine the report is exactly what it always was', async () => {
  // The flag adds a section. It must not quietly change the one that was there.
  const dir = project(TS_FULL);
  const { code, out } = await capture(dir, [], runnerFor(TS_FULL));
  assert.equal(code, 0);
  assert.match(out, /already enforced/);
  assert.doesNotMatch(out, /doctrine coverage/);
  assert.doesNotMatch(out, /suggestions \(/);
});

test('--doctrine adds keys to --json and rewrites none of the ones that were there', async () => {
  const dir = project(TS_FULL);
  const runner = runnerFor(TS_FULL, {
    'npx --no-install eslint --print-config': printConfig({ 'max-params': ['warn', { max: 2 }] }),
  });

  const plain = JSON.parse((await capture(dir, ['--json'], runnerFor(TS_FULL))).out);
  const withDoctrine = JSON.parse((await capture(dir, ['--json', '--doctrine'], runner)).out);

  for (const key of Object.keys(plain)) {
    assert.deepEqual(withDoctrine[key], plain[key], `--doctrine rewrote ${key}`);
  }
  for (const key of ['stack', 'tooling', 'doctrine', 'suggestions', 'summary']) {
    assert.ok(key in withDoctrine, `--doctrine did not add ${key}`);
  }
  assert.equal(withDoctrine.doctrine.find((d) => d.id === 'options-objects').verdict, 'covered');
});

test('a resolve that cannot run reports unknown, proposes nothing, and still exits 0', async () => {
  // eslint configured but not installed is the ordinary state of a fresh
  // clone. It is not an error, and it is not evidence that a rule is absent.
  const dir = project(TS_FULL);
  const { code, out } = await capture(dir, ['--doctrine'], runnerFor(TS_FULL));
  assert.equal(code, 0);
  assert.match(out, /not installed|command not found/);
  assert.match(out, /unknown/);
  assert.doesNotMatch(out, /suggestions \(/);
});

test('a project with no linter is told so, and is given no rules', async () => {
  const dir = project(TS_BARE);
  const { code, out } = await capture(dir, ['--doctrine'], runnerFor(TS_BARE));
  assert.equal(code, 0);
  assert.match(out, /no linter is configured/);
  assert.doesNotMatch(out, /suggestions \(/, 'nothing can be proposed into a linter that is not there');
});

test('a biome project is read from its config, and never handed ESLint rules', async () => {
  // Refusal: the skill proposes rules inside the tool already in place. A
  // second linter is a decision nobody asked this command to make.
  const dir = project(BIOME);
  const { out } = await capture(dir, ['--doctrine'], runnerFor(BIOME, {
    'npx --no-install biome --version': { ok: true, code: 0, stdout: '1.9.4', stderr: '' },
  }));
  assert.match(out, /read from biome\.json/);
  assert.doesNotMatch(out, /'max-params'|"max-params"/, 'an ESLint rule must not be proposed to a biome project');
});

test('a tree with no recognised stack proposes nothing at all', async () => {
  const dir = project(NO_STACK);
  const { code, out } = await capture(dir, ['--doctrine'], runnerFor(NO_STACK));
  assert.equal(code, 0);
  assert.doesNotMatch(out, /suggestions \(/);
});

test('two runs over an unchanged tree print the same bytes', async () => {
  // Rule 4, and the idempotence check: proving a second run changed nothing
  // has to cost one diff.
  const dir = project(MONO);
  const runner = runnerFor(MONO, {
    'npx --no-install eslint --print-config': printConfig({ complexity: ['warn', { max: 8 }] }),
  });
  const first = await capture(dir, ['--doctrine'], runner);
  const second = await capture(dir, ['--doctrine'], runner);
  assert.equal(first.out, second.out);
});

test('the resolve target is named in the report, so the answer can be reproduced', async () => {
  // ESLint resolves per path, so a repo with per-directory overrides has no
  // single answer. Printing which file was asked about is what makes the
  // report checkable rather than merely confident.
  const dir = project(TS_FULL);
  const { out } = await capture(dir, ['--doctrine'], runnerFor(TS_FULL, {
    'npx --no-install eslint --print-config': printConfig({}),
  }));
  assert.match(out, /--print-config src\/index\.ts/);
});

test('a config that matches none of a file is tried against the next one', () => {
  // Found live, against a real ESLint 9: `--print-config` prints the literal
  // word `undefined` for a file no config object matches, and a flat config
  // with no `files` key matches .js and not .ts. Asking about the sorted-first
  // source file therefore reported every rule unknown in a project whose
  // configuration was sitting right there.
  assert.ok(true, 'documented by the two cases below');
});

test('eslint answering undefined for one file is retried against another', async () => {
  const dir = project(TS_FULL);
  const runner = runnerFor(TS_FULL, {
    // src/index.ts is sorted first and matches nothing; src/ui/button.tsx does.
    'npx --no-install eslint --print-config src/index.ts': { ok: true, code: 0, stdout: 'undefined', stderr: '' },
    'npx --no-install eslint --print-config': printConfig({ 'max-params': ['warn', { max: 2 }] }),
  });
  const { out } = await capture(dir, ['--doctrine'], runner);
  assert.match(out, /--print-config src\/ui\/button\.tsx/, 'it must move on to a file the config covers');
  assert.doesNotMatch(out, /is not valid JSON/, 'undefined is a config answer, not a parse failure');
  assert.match(out, /covered/);
});

test('a config that matches no source file at all says exactly that', async () => {
  // The honest finding: an ESLint config that lints nothing in this repo. It
  // is not a parse error and it is not a missing rule.
  const dir = project(TS_FULL);
  const runner = runnerFor(TS_FULL, {
    'npx --no-install eslint --print-config': { ok: true, code: 0, stdout: 'undefined', stderr: '' },
  });
  const { code, out } = await capture(dir, ['--doctrine'], runner);
  assert.equal(code, 0);
  assert.match(out, /matches none of/);
  assert.doesNotMatch(out, /is not valid JSON/);
  assert.doesNotMatch(out, /suggestions \(/);
});
