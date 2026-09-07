/**
 * Work units, with no I/O in them (#103).
 *
 * A dependency between two units is a line in the child's body and nothing
 * else, so the whole of what `split` writes and `build` reads back is a pure
 * round trip that can be asserted here without a tracker.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { idSyntaxFor } from '../lib/issueid.mjs';
import { UNKNOWN } from '../lib/sync.mjs';
import {
  classifyUnits,
  computeWaves,
  parseDependsOn,
  parseUnitRepo,
  parseUnitsFile,
  readyUnits,
  renderUnitBody,
} from '../lib/units.mjs';

const GITHUB = {
  provider: 'github',
  states: { ladder: ['Backlog', 'In Progress', 'In Review', 'Done'], start: 'In Progress', review: 'In Review', done: 'Done' },
  issueTypes: ['Bug', 'Feature'],
};
const YOUTRACK = {
  provider: 'youtrack',
  project: 'ABC',
  states: { ladder: ['Open', 'In Progress', 'In Review', 'Done'], start: 'In Progress', review: 'In Review', done: 'Done' },
  issueTypes: ['Bug', 'Feature', 'Task'],
};

// --- the Depends on: line -----------------------------------------------------

test('renderUnitBody writes one Depends on: line, and none when there is nothing to depend on', () => {
  const withDeps = renderUnitBody({ description: '## Problem\n\nx\n', dependsOn: ['#43', '#44'] });
  assert.match(withDeps, /^## Problem\n\nx\n\nDepends on: #43, #44\n$/);

  const alone = renderUnitBody({ description: '## Problem\n\nx', dependsOn: [] });
  assert.equal(alone, '## Problem\n\nx\n');
  assert.doesNotMatch(alone, /Depends on/);
});

test('renderUnitBody writes a Repo: line for a multi-repo unit, and parseUnitRepo reads it back', () => {
  const body = renderUnitBody({ description: 'x', dependsOn: ['#43'], repo: 'web' });
  assert.equal(body, 'x\n\nRepo: web\nDepends on: #43\n');
  assert.equal(parseUnitRepo(body), 'web');
  assert.equal(parseDependsOn(body, idSyntaxFor(GITHUB))[0], '#43');
  assert.equal(parseUnitRepo('no such line'), null);
});

test('parseDependsOn round-trips GitHub and YouTrack IDs and reads only that line', () => {
  for (const [config, ids] of [
    [GITHUB, ['#43', '#44']],
    [YOUTRACK, ['ABC-1', 'ABC-2']],
  ]) {
    const body = renderUnitBody({ description: `Fixes the thing described in ${ids[0]} and more.`, dependsOn: ids });
    assert.deepEqual(parseDependsOn(body, idSyntaxFor(config)), ids, `${config.provider} must round-trip`);
  }
});

test('parseDependsOn answers [] for an absent line, a "none", and an empty body', () => {
  const syntax = idSyntaxFor(GITHUB);
  assert.deepEqual(parseDependsOn('Mentions #7 in prose only.', syntax), []);
  assert.deepEqual(parseDependsOn('Depends on: none', syntax), []);
  assert.deepEqual(parseDependsOn('', syntax), []);
  assert.deepEqual(parseDependsOn(null, syntax), []);
});

test('parseDependsOn canonicalises the spelling and drops duplicates', () => {
  const syntax = idSyntaxFor(GITHUB);
  assert.deepEqual(parseDependsOn('Depends on: acme/api#43, #43, #44', syntax), ['#43', '#44']);
});

// --- waves --------------------------------------------------------------------

test('computeWaves orders a DAG into waves, keeping input order inside a wave', () => {
  const r = computeWaves([
    { id: 'c', dependsOn: ['a', 'b'] },
    { id: 'a', dependsOn: [] },
    { id: 'd', dependsOn: ['c'] },
    { id: 'b', dependsOn: [] },
  ]);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.waves, [['a', 'b'], ['c'], ['d']]);
  assert.equal(r.waveOf.get('d'), 3);
});

test('computeWaves names the IDs in a cycle rather than looping or guessing', () => {
  const r = computeWaves([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: [] },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /cycle/);
  assert.match(r.error, /a/);
  assert.match(r.error, /b/);
  assert.doesNotMatch(r.error, /\bc\b/, 'a unit outside the cycle is not blamed for it');
});

test('computeWaves treats a dependency outside the set as external and reports it', () => {
  const r = computeWaves([
    { id: '#45', dependsOn: ['#12'] },
    { id: '#46', dependsOn: ['#45'] },
  ]);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.waves, [['#45'], ['#46']]);
  assert.deepEqual(r.external, [{ id: '#45', dependsOn: ['#12'] }]);
});

test('computeWaves of nothing is no waves, not an error', () => {
  const r = computeWaves([]);
  assert.ok(r.ok);
  assert.deepEqual(r.waves, []);
});

// --- readiness ----------------------------------------------------------------

const units = [
  { id: '#43', dependsOn: [] },
  { id: '#44', dependsOn: [] },
  { id: '#45', dependsOn: ['#43'] },
  { id: '#46', dependsOn: ['#44'] },
  { id: '#47', dependsOn: ['#43', '#12'] },
  { id: '#48', dependsOn: [] },
  { id: '#49', dependsOn: [] },
];

test('classifyUnits buckets by tracker state first, then by dependencies', () => {
  const states = new Map([
    ['#43', 'Done'],
    ['#44', 'In Review'],
    ['#45', 'Backlog'],
    ['#46', 'Backlog'],
    ['#47', 'Backlog'],
    ['#12', 'Done'],
    ['#48', UNKNOWN],
    ['#49', 'not planned'],
  ]);
  const by = classifyUnits(units, states, GITHUB);
  assert.equal(by.get('#43').bucket, 'done');
  assert.equal(by.get('#44').bucket, 'review');
  assert.equal(by.get('#45').bucket, 'ready');
  assert.deepEqual(by.get('#46'), { bucket: 'blocked', waitsOn: ['#44'] });
  assert.equal(by.get('#47').bucket, 'ready', 'an external dependency that is done does not block');
  assert.equal(by.get('#48').bucket, 'unknown');
  assert.equal(by.get('#49').bucket, 'unknown', 'off the ladder is never started automatically');
  assert.match(by.get('#49').why, /states\.ladder/, 'the hint names the key to change');
});

test('a started unit is in progress, whatever its dependencies say', () => {
  const states = new Map([['#43', 'In Progress'], ['#45', 'In Progress']]);
  const by = classifyUnits(units.slice(0, 3), states, GITHUB);
  assert.equal(by.get('#45').bucket, 'in progress');
});

test('readyUnits never returns a unit whose dependency is UNKNOWN, off-ladder, in review or unstarted', () => {
  const states = new Map([
    ['#43', UNKNOWN],
    ['#44', 'In Review'],
    ['#45', 'Backlog'],
    ['#46', 'Backlog'],
    ['#47', 'Backlog'],
    ['#12', 'not planned'],
    ['#48', 'Backlog'],
    ['#49', 'Backlog'],
  ]);
  assert.deepEqual(readyUnits(units, states, GITHUB), ['#48', '#49']);
});

// --- the units file ------------------------------------------------------------

const GOOD = [
  { summary: 'Parser', description: '## Problem\n\nx\n\n## Acceptance criteria\n\n- [ ] AC1: y', type: 'Feature' },
  { summary: 'Renderer', description: '## Acceptance criteria\n\n- [ ] AC2: z', type: 'Bug', dependsOn: [0] },
];

test('parseUnitsFile accepts a well-formed file and resolves index dependencies', () => {
  const r = parseUnitsFile(JSON.stringify(GOOD), GITHUB);
  assert.ok(r.ok, r.error);
  assert.equal(r.units.length, 2);
  assert.deepEqual(r.units[1].dependsOn, [0]);
  assert.deepEqual(r.units[0].dependsOn, []);
});

test('parseUnitsFile names the unit and the field it refuses', () => {
  const bad = (patch, at = 0) => {
    const units = GOOD.map((u) => ({ ...u }));
    Object.assign(units[at], patch);
    return parseUnitsFile(JSON.stringify(units), GITHUB);
  };
  for (const [patch, field] of [
    [{ summary: '' }, /unit 1.*summary/s],
    [{ description: '## Problem\n\nno criteria here' }, /unit 1.*Acceptance criteria/s],
    [{ type: 'Epic' }, /unit 1.*type.*issueTypes/s],
    [{ dependsOn: [5] }, /unit 1.*dependsOn.*5/s],
    [{ dependsOn: [0] }, /unit 1.*dependsOn.*itself/s],
    [{ dependsOn: ['#43'] }, /unit 1.*dependsOn.*index/s],
  ]) {
    const r = bad(patch);
    assert.equal(r.ok, false, `${JSON.stringify(patch)} must be refused`);
    assert.match(r.error, field);
  }
});

test('parseUnitsFile refuses what is not a JSON array, and an empty one', () => {
  assert.equal(parseUnitsFile('{"summary":"x"}', GITHUB).ok, false);
  assert.equal(parseUnitsFile('[]', GITHUB).ok, false);
  assert.match(parseUnitsFile('nope', GITHUB).error, /JSON/);
});

test('parseUnitsFile requires a repo on every unit when the project configures several', () => {
  const multi = { ...GITHUB, repos: [{ path: 'api' }, { path: 'web' }] };
  const r = parseUnitsFile(JSON.stringify(GOOD), multi);
  assert.equal(r.ok, false);
  assert.match(r.error, /unit 1.*repo/s);

  const ok = parseUnitsFile(JSON.stringify(GOOD.map((u) => ({ ...u, repo: 'web' }))), multi);
  assert.ok(ok.ok, ok.error);

  const unknown = parseUnitsFile(JSON.stringify(GOOD.map((u) => ({ ...u, repo: 'nope' }))), multi);
  assert.match(unknown.error, /repo.*nope.*api, web/s);
});
