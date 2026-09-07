/**
 * `dev.mjs split` end to end, against the table-mode `gh` stub (#103).
 *
 * What the stub can prove: the order of the writes, that a refused file writes
 * nothing, that a rerun files nothing twice, and that the bodies carry the
 * dependency line `build` reads back. It cannot prove the sub-issue mutation
 * exists on the real API; CONTRIBUTING.md is where that is exercised.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG, withStubGh } from './ghstub.mjs';

const PARENT = {
  12: {
    number: 12,
    title: 'Half a thing',
    body: '## Plan\n\nthree parts',
    state: 'OPEN',
    stateReason: null,
    url: 'https://github.com/o/r/issues/12',
    labels: ['status: in progress'],
    subIssues: [],
  },
};

const UNITS = [
  { summary: 'Parser', description: '## Acceptance criteria\n\n- [ ] AC1: parses', type: 'Feature' },
  { summary: 'Renderer', description: '## Acceptance criteria\n\n- [ ] AC2: renders', type: 'Feature', dependsOn: [0] },
  { summary: 'Wiring', description: '## Acceptance criteria\n\n- [ ] AC3: wired', type: 'Bug', dependsOn: [0, 1] },
];

const CFG = { ...CONFIG, issueTypes: ['Bug', 'Feature'] };

async function setup(units = UNITS, issues = PARENT) {
  const s = await withStubGh({ config: CFG, issues: structuredClone(issues) });
  const file = join(s.root, 'units.json');
  writeFileSync(file, JSON.stringify(units));
  return { ...s, file };
}

test('split --print renders the waves and files nothing', async () => {
  const { dev, file, read, issues } = await setup();

  const r = await dev(['split', '#12', `@${file}`, '--print']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /parent: +#12 — Half a thing/);
  assert.match(r.stdout, /nothing was filed/);
  assert.match(r.stdout, /wave 1\n +unit 1 +Parser\nwave 2\n +unit 2 +Renderer +depends on unit 1\nwave 3\n +unit 3 +Wiring +depends on unit 1, unit 2/);
  assert.doesNotMatch(read('log'), /issue create/);
  assert.deepEqual(Object.keys(issues()), ['12']);
});

test('split files the units in wave order, links each under the parent, and writes the dependency line', async () => {
  const { dev, file, read, issues } = await setup();

  const r = await dev(['split', '#12', `@${file}`]);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /filed: +3 new/);
  assert.match(r.stdout, /wave 1\n +#13 +Parser\nwave 2\n +#14 +Renderer +depends on #13\nwave 3\n +#15 +Wiring +depends on #13, #14/);

  const table = issues();
  assert.deepEqual(table[12].subIssues, [13, 14, 15]);
  assert.equal(table[13].title, 'Parser');
  assert.doesNotMatch(table[13].body, /Depends on/);
  assert.match(table[14].body, /- \[ \] AC2: renders\n\nDepends on: #13$/);
  assert.match(table[15].body, /Depends on: #13, #14$/);

  // Creates precede links, and the order of the creates is the wave order.
  const creates = read('log').split('\n').filter((l) => l.startsWith('issue create'));
  assert.equal(creates.length, 3);
  assert.match(creates[0], /--title Parser/);
  assert.match(creates[1], /--title Renderer/);
  assert.match(creates[2], /--title Wiring/);
});

test('a rerun after a partial split files only what is missing, and stands the existing ID in as a dependency', async () => {
  // As if the first run filed Parser and died: the parent already lists it.
  const already = structuredClone(PARENT);
  already[13] = { number: 13, title: 'Parser', body: 'filed earlier', state: 'OPEN', stateReason: null, url: 'https://github.com/o/r/issues/13', labels: [], subIssues: [] };
  already[12].subIssues = [13];
  const { dev, file, read, issues } = await setup(UNITS, already);

  const r = await dev(['split', '#12', `@${file}`]);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /filed: +2 new, 1 already filed/);
  assert.match(r.stdout, /#13 +Parser.*\(already filed\)/);
  assert.equal(read('log').split('\n').filter((l) => l.startsWith('issue create')).length, 2);
  const table = issues();
  assert.deepEqual(table[12].subIssues, [13, 14, 15]);
  assert.match(table[14].body, /Depends on: #13/);
  assert.equal(table[13].body, 'filed earlier', 'the existing unit is left alone');
});

test('a cycle is refused before anything is filed', async () => {
  const { dev, file, read, issues } = await setup([
    { ...UNITS[0], dependsOn: [1] },
    { ...UNITS[1], dependsOn: [0] },
  ]);

  const r = await dev(['split', '#12', `@${file}`]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /cycle/);
  assert.doesNotMatch(read('log'), /issue/, 'a bad file costs no tracker call at all');
  assert.deepEqual(Object.keys(issues()), ['12']);
});

test('a unit with no acceptance criteria is refused by unit number and field', async () => {
  const { dev, file, read } = await setup([{ ...UNITS[0], description: '## Problem\n\nno criteria' }]);

  const r = await dev(['split', '#12', `@${file}`]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /unit 1: description must carry a "## Acceptance criteria"/);
  assert.doesNotMatch(read('log'), /issue/);
});

test('the units must come from a file, and the parent must exist', async () => {
  const { dev, file } = await setup();

  const inline = await dev(['split', '#12', '[]']);
  assert.equal(inline.code, 1);
  assert.match(inline.stderr, /@units\.json/);

  const missing = await dev(['split', '#404', `@${file}`]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Could not resolve|not found/i);
});

test('fetch prints the sub-issues once a ticket is split, and nothing extra before', async () => {
  const { dev, file } = await setup();

  const before = await dev(['fetch', '#12']);
  assert.equal(before.code, 0, before.stderr);
  assert.doesNotMatch(before.stdout, /Sub-issues/);

  assert.equal((await dev(['split', '#12', `@${file}`])).code, 0);

  const after = await dev(['fetch', '#12']);
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.stdout, /## Sub-issues \(3\)\n\n- #13 — Parser\n- #14 — Renderer\n- #15 — Wiring/);
});
