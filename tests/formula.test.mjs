/**
 * The Homebrew formula follows every release without a hand: `bumpFormula`
 * rewrites its `url` and `sha256` from the tarball the registry serves, and
 * refuses a formula it does not recognise rather than guessing at one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { bumpFormula, fetchTarballSha256, formulaVersion, tarballUrl } from '../tools/bump-formula.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FORMULA = readFileSync(join(ROOT, 'Formula', 'claude-dev-workflow.rb'), 'utf8');
const SHA = 'a'.repeat(64);

test('tarballUrl is the registry path for a version', () => {
  assert.equal(tarballUrl('2.0.0'), 'https://registry.npmjs.org/claude-dev-workflow/-/claude-dev-workflow-2.0.0.tgz');
});

test('formulaVersion reads the version the formula currently points at', () => {
  assert.match(formulaVersion(FORMULA), /^\d+\.\d+\.\d+$/);
  assert.equal(formulaVersion('class X < Formula\nend\n'), null);
});

test('bumpFormula rewrites exactly the url and sha256 lines', () => {
  const out = bumpFormula(FORMULA, { version: '2.0.0', sha256: SHA });
  assert.equal(out.ok, true, out.error);
  assert.match(out.text, /^  url "https:\/\/registry\.npmjs\.org\/claude-dev-workflow\/-\/claude-dev-workflow-2\.0\.0\.tgz"$/m);
  assert.match(out.text, new RegExp(`^  sha256 "${SHA}"$`, 'm'));
  const diff = FORMULA.split('\n').filter((line, i) => line !== out.text.split('\n')[i]);
  assert.equal(diff.length, 2, `only two lines change, got: ${diff.join(' | ')}`);
  assert.equal(formulaVersion(out.text), '2.0.0');
});

test('bumpFormula is idempotent for the version it already names', () => {
  const sha = FORMULA.match(/sha256 "([0-9a-f]{64})"/)[1];
  const out = bumpFormula(FORMULA, { version: formulaVersion(FORMULA), sha256: sha });
  assert.equal(out.ok, true);
  assert.equal(out.text, FORMULA);
  assert.equal(out.changed, false);
});

test('bumpFormula refuses a formula it does not recognise, and a malformed sha', () => {
  assert.equal(bumpFormula('class X < Formula\nend\n', { version: '2.0.0', sha256: SHA }).ok, false);
  const bad = bumpFormula(FORMULA, { version: '2.0.0', sha256: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /sha256/);
  const badVersion = bumpFormula(FORMULA, { version: 'v2', sha256: SHA });
  assert.equal(badVersion.ok, false);
  assert.match(badVersion.error, /version/);
});

test('fetchTarballSha256 hashes the bytes the registry serves, retrying a bounded number of times while it 404s', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('tarball bytes').buffer };
  };
  const sha = await fetchTarballSha256('2.0.0', { fetchImpl, attempts: 5, delayMs: 0 });
  assert.equal(calls, 3);
  const { createHash } = await import('node:crypto');
  assert.equal(sha, createHash('sha256').update('tarball bytes').digest('hex'));

  let exhausted = 0;
  const never = async () => {
    exhausted++;
    return { ok: false, status: 404 };
  };
  await assert.rejects(fetchTarballSha256('2.0.0', { fetchImpl: never, attempts: 3, delayMs: 0 }), /3 attempts/);
  assert.equal(exhausted, 3);
});
