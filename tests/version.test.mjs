/**
 * Packaging invariants.
 *
 * `files` is an allowlist: a new directory that the installer copies from but
 * that npm does not ship produces an install that silently writes nothing. That
 * is the failure this file exists to catch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planFiles } from '../bin/lib/payload.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the version is a plain semver triple', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `unexpected version format: ${pkg.version}`);
});

test('every shipped path in package.json files exists', () => {
  for (const f of pkg.files) {
    assert.ok(existsSync(join(ROOT, f)), `package.json "files" lists ${f}, which does not exist`);
  }
});

test('everything the installer copies is in package.json files', () => {
  // The installer reads from lib/, scripts/, hooks/ and skills/. If npm does
  // not ship one of them, `npx` installs an incomplete project.
  const shipped = new Set(pkg.files);
  const sourceDirs = new Set(
    [...planFiles(ROOT).values()].map((abs) => abs.slice(ROOT.length + 1).split('/')[0]),
  );

  for (const dir of sourceDirs) {
    assert.ok(shipped.has(dir), `the installer copies from ${dir}/, but package.json files omits it`);
  }
});

test('the installer itself is shipped', () => {
  assert.ok(pkg.files.includes('bin'));
  // Asserted against pkg.name rather than a literal: the previous version
  // hardcoded 'youtrack-workflow' and went stale the moment the product was
  // renamed. `npx <name>` is what users type, so the two must agree.
  assert.deepEqual(Object.keys(pkg.bin), [pkg.name]);
  assert.equal(pkg.bin[pkg.name], './bin/install.mjs');
  assert.ok(existsSync(join(ROOT, 'bin', 'install.mjs')));
});

test('the runtime payload declares no dependencies', () => {
  // lib/, scripts/ and hooks/ are copied into projects with no node_modules.
  // Anything they import must come from node:.
  //
  // hooks/ joined this list when the first Node hook shipped. It was bash-only
  // before that, so the sweep could skip it — and a sweep that still skipped it
  // would leave the one file most likely to be written in a hurry, and the only
  // one that runs before anything else in a session, entirely unchecked.
  const offenders = [];
  for (const abs of planFiles(ROOT).values()) {
    if (!abs.endsWith('.mjs')) continue;
    const rel = abs.slice(ROOT.length + 1);
    if (!['lib/', 'scripts/', 'hooks/'].some((dir) => rel.startsWith(dir))) continue;

    for (const m of readFileSync(abs, 'utf8').matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      const isLocal = spec.startsWith('.') || spec.startsWith('/');
      if (!isLocal && !spec.startsWith('node:')) offenders.push(`${rel} imports ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'the installed payload must import only node: builtins');
});
