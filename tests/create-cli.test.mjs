/**
 * `dev create` end to end, against the `gh` stub.
 *
 * What these prove is *ordering* and *refusal* — that a duplicate scan ran
 * before anything was filed, that a refusal filed nothing, that an override
 * filed exactly once — which is the class of thing the stub is good for. The
 * matcher itself is unit-tested in create.test.mjs; here it only has to hit or
 * miss the two titles the stub holds.
 *
 * stdout is asserted byte for byte throughout. `create` prints the new ID and
 * nothing else on success, and the candidates and nothing else on refusal, so
 * a caller can capture either directly; a stray line there is a regression.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withStubGh } from './ghstub.mjs';

const filed = (log) => log.split('\n').filter((l) => l.startsWith('issue create')).length;

// --- the scan runs on every file --------------------------------------------------

test('a summary matching an open issue is refused: candidates out, exit 2, nothing filed', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', 'body']);

  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, '#12\tHalf a thing\n', 'stdout carries the candidates in --dup-check format');
  assert.match(r.stderr, /--allow-duplicate/, 'the refusal names the override flag');
  assert.match(r.stderr, /#12/, 'the refusal names what it matched');
  assert.equal(filed(s.read('log')), 0, 'nothing was filed');
  assert.equal(s.read('created'), '');
});

test('--allow-duplicate files anyway, says what it matched, and prints only the ID', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', 'body', '--allow-duplicate']);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n', 'stdout is the new ID alone');
  assert.match(r.stderr, /duplicate check overridden — matched #12/);
  assert.equal(filed(s.read('log')), 1);
  assert.match(s.read('created'), /^title\tHalf a thing is still broken\n/);
});

test('the flag may come before the positionals', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--allow-duplicate', 'Half a thing is still broken', 'body']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
});

test('no match files, and does not mention the flag', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Rotate the frobnicator quarterly', 'body']);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.doesNotMatch(r.stderr, /allow-duplicate|overridden/);
  assert.equal(filed(s.read('log')), 1);

  const searches = s.read('log').split('\n').filter((l) => /issue list .*--search/.test(l));
  assert.equal(searches.length, 1, 'the scan ran exactly once');
  assert.match(searches[0], /--search rotate frobnicator quarterly/, 'keywords come from the summary');
});

test('the scan runs before the write, never after it', async () => {
  const s = await withStubGh();
  await s.dev(['create', 'Rotate the frobnicator quarterly', 'body']);
  const lines = s.read('log').split('\n');
  const scan = lines.findIndex((l) => /issue list .*--search/.test(l));
  const write = lines.findIndex((l) => l.startsWith('issue create'));
  assert.ok(scan >= 0 && write >= 0);
  assert.ok(scan < write, 'the scan must precede the write');
});

// --- the check may never become a new way for filing to fail ----------------------

test('a search failure warns and files', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', 'body'], { GH_FAIL_SEARCH: '1' });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /duplicate scan skipped — /);
  assert.match(r.stderr, /search is unavailable/, 'the reason is surfaced, not swallowed');
  assert.equal(filed(s.read('log')), 1);
});

// --- --dup-check alone is unchanged ------------------------------------------------
//
// skills/dev-init runs it as a credentials smoke test and reads "no open
// issues matched" or a list as success; both spellings and the exit code are
// load-bearing there.

test('--dup-check reports matches, exits 0, files nothing', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--dup-check', 'half']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#12\tHalf a thing\n');
  assert.equal(filed(s.read('log')), 0);
});

test('--dup-check with no match says so, exits 0', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--dup-check', 'frobnicator']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'no open issues matched\n');
});

test('--dup-check without keywords is a usage error', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--dup-check']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--dup-check needs a value/);
});

// --- usage --------------------------------------------------------------------------

test('an unknown flag is refused rather than read as a summary', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--bogus', 'x', 'y']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag --bogus/);
});

test('a missing description is a usage error, with nothing scanned or filed', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'only a summary']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: dev\.mjs create/);
  assert.equal(s.read('log'), '');
});
