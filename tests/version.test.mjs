/**
 * The version lives in two manifests and is bumped by hand at release time.
 * A mismatch ships a plugin whose manifest lies about what it is, which is
 * invisible until someone reads it — so assert they agree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

test('package.json and plugin.json declare the same version', () => {
  const pkg = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(
    plugin.version,
    pkg.version,
    `.claude-plugin/plugin.json is ${plugin.version} but package.json is ${pkg.version} — bump both`,
  );
});

test('the version is a plain semver triple', () => {
  const { version } = read('package.json');
  assert.match(version, /^\d+\.\d+\.\d+$/, `unexpected version format: ${version}`);
});

test('every shipped path in package.json files exists', () => {
  const { files } = read('package.json');
  for (const f of files) {
    assert.ok(existsSync(join(ROOT, f)), `package.json "files" lists ${f}, which does not exist`);
  }
});
