/**
 * The manifest schema, read from the side that ships.
 *
 * `bin/lib/payload.mjs` writes this file and `lib/manifest.mjs` reads it back.
 * Two readers of one schema is the drift CLAUDE.md warns about, so the last test
 * here asserts they are literally the same function rather than two copies that
 * happen to agree today.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { MANIFEST_PATH, compareVersions, detectDrift, readManifest, sha256 } from '../lib/manifest.mjs';
import * as payload from '../bin/lib/payload.mjs';

const roots = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dw-manifest-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Write `files` (relPath -> body) into a scratch root and record a manifest for them. */
function project(files, { version = '2.0.0' } = {}) {
  const root = scratch();
  const entries = [];
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    entries.push({ path: rel, sha256: sha256(Buffer.from(body)) });
  }
  const manifest = {
    installation: { version, installDate: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-02T00:00:00.000Z' },
    files: entries,
  };
  const manifestAbs = join(root, MANIFEST_PATH);
  mkdirSync(dirname(manifestAbs), { recursive: true });
  writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest };
}

test('detectDrift: an untouched install is clean', () => {
  const { root, manifest } = project({ '_dev-workflow/lib/a.mjs': 'alpha\n' });
  assert.deepEqual(detectDrift(root, manifest), {
    modified: [],
    missing: [],
    clean: ['_dev-workflow/lib/a.mjs'],
  });
});

test('detectDrift: an edited file is reported, not silently adopted', () => {
  const { root, manifest } = project({ '_dev-workflow/lib/a.mjs': 'alpha\n' });
  writeFileSync(join(root, '_dev-workflow/lib/a.mjs'), 'edited by hand\n');
  const drift = detectDrift(root, manifest);
  assert.deepEqual(drift.modified, ['_dev-workflow/lib/a.mjs']);
  assert.deepEqual(drift.clean, []);
});

test('detectDrift: a deleted file is missing, not modified', () => {
  const { root, manifest } = project({ '_dev-workflow/lib/a.mjs': 'alpha\n', '_dev-workflow/lib/b.mjs': 'beta\n' });
  rmSync(join(root, '_dev-workflow/lib/b.mjs'));
  const drift = detectDrift(root, manifest);
  assert.deepEqual(drift.missing, ['_dev-workflow/lib/b.mjs']);
  assert.deepEqual(drift.modified, []);
  assert.deepEqual(drift.clean, ['_dev-workflow/lib/a.mjs']);
});

test('detectDrift: no manifest is not a crash', () => {
  assert.deepEqual(detectDrift(scratch(), null), { modified: [], missing: [], clean: [] });
});

test('readManifest: absent and corrupt both read as null', () => {
  const root = scratch();
  assert.equal(readManifest(root), null);

  const abs = join(root, MANIFEST_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '{ not json');
  assert.equal(readManifest(root), null, 'a corrupt manifest must not throw — an update has to be able to repair it');
});

test('readManifest: reads the version back', () => {
  const { root } = project({ '_dev-workflow/lib/a.mjs': 'alpha\n' }, { version: '2.3.1' });
  assert.equal(readManifest(root).installation.version, '2.3.1');
});

test('compareVersions orders semver triples', () => {
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.0.0', '2.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '2.1.0'), -1);
  assert.equal(compareVersions('2.0.0', '3.0.0'), -1);
  assert.equal(compareVersions('2.1.0', '2.0.9'), 1);
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1, 'numeric, not lexicographic');
});

test('compareVersions returns null rather than guessing', () => {
  for (const bad of [undefined, null, '', '2.0', 'v2.0.0', '2.0.0-rc.1', 'abc123']) {
    assert.equal(compareVersions(bad, '2.0.0'), null, `expected null for ${JSON.stringify(bad)}`);
    assert.equal(compareVersions('2.0.0', bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('the installer and the payload share one manifest reader', () => {
  // Not decoration: if these ever become two implementations, an installer
  // change to the schema stops being visible to `dev.mjs version`.
  assert.equal(payload.detectDrift, detectDrift);
  assert.equal(payload.readManifest, readManifest);
  assert.equal(payload.MANIFEST_PATH, MANIFEST_PATH);
});
