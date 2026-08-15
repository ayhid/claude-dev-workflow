import assert from 'node:assert/strict';
import { test } from 'node:test';

import { has, sh, shJson, shOrThrow } from '../lib/sh.mjs';

test('sh captures stdout and reports success', async () => {
  const r = await sh('node', ['-e', 'process.stdout.write("hello")']);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hello');
});

test('sh does not throw on a non-zero exit', async () => {
  // Probing for something that is not there is normal, not exceptional.
  const r = await sh('node', ['-e', 'process.exit(3)']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
});

test('sh captures stderr rather than streaming it', async () => {
  const r = await sh('node', ['-e', 'process.stderr.write("boom"); process.exit(1)']);
  assert.equal(r.ok, false);
  assert.equal(r.stderr, 'boom');
});

test('sh reports a missing binary as 127 instead of throwing', async () => {
  const r = await sh('definitely-not-a-real-binary-xyz', ['--version']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 127);
});

test('sh passes arguments through untouched', async () => {
  // The whole reason for argument arrays: spaces, quotes and $ must survive.
  const tricky = 'a b "c" $HOME \'d\' ;rm -rf /';
  const r = await sh('node', ['-e', 'process.stdout.write(process.argv[1])', tricky]);
  assert.equal(r.stdout, tricky);
});

test('sh trims trailing newlines', async () => {
  const r = await sh('node', ['-e', 'process.stdout.write("x\\n\\n")']);
  assert.equal(r.stdout, 'x');
});

test('shOrThrow returns stdout on success', async () => {
  assert.equal(await shOrThrow('node', ['-e', 'process.stdout.write("ok")']), 'ok');
});

test('shOrThrow attaches stderr to the error', async () => {
  // Swallowing this is what turned a parser error into a bare "update failed".
  await assert.rejects(
    () => shOrThrow('node', ['-e', 'process.stderr.write("the real reason"); process.exit(1)']),
    /the real reason/,
  );
});

test('shJson parses stdout', async () => {
  const r = await shJson('node', ['-e', 'process.stdout.write(JSON.stringify({a:1}))']);
  assert.deepEqual(r, { ok: true, data: { a: 1 } });
});

test('shJson reports unparseable output without throwing', async () => {
  const r = await shJson('node', ['-e', 'process.stdout.write("not json")']);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not parse/);
});

test('shJson reports a failed command', async () => {
  const r = await shJson('node', ['-e', 'process.stderr.write("nope"); process.exit(1)']);
  assert.equal(r.ok, false);
  assert.match(r.error, /nope/);
});

test('has finds a binary that exists and rejects one that does not', async () => {
  assert.equal(await has('node'), true);
  assert.equal(await has('definitely-not-a-real-binary-xyz'), false);
});

test('has is true for a binary that exists but fails --version', async () => {
  // `git --version` works, but plenty of tools exit non-zero on it. Presence is
  // the question, not whether the probe succeeded.
  const r = await sh('node', ['-e', 'process.exit(2)']);
  assert.equal(r.code, 2, 'a non-127 exit means the binary was found');
});
