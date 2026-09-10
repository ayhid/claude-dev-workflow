/**
 * Board-level selection, with no I/O in it (#146).
 *
 * Every case here is a plain object: the selector never reads a file, spawns
 * git or reaches the tracker, so the whole of what `dev.mjs fleet` will decide
 * is decidable in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFleet, countCriteria, orderCandidates, planOf, selectFleet } from '../lib/fleet.mjs';

const CONFIG = {
  provider: 'github',
  states: {
    ladder: ['Backlog', 'In Progress', 'In Review', 'Done'],
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
  },
  issueTypes: ['Bug', 'Feature', 'Task'],
  branch: { types: { Bug: 'fix', Feature: 'feat', Task: 'chore' } },
  commit: { types: ['feat', 'fix', 'chore'] },
};

const PLAN = [{ author: 'a', at: null, body: '## Plan\n\n- [ ] AC1: does the thing\n' }];

/** A ticket on the first rung, planned, depending on nothing: fleet-ready. */
function ticket(id, over = {}) {
  return { id, type: 'Feature', dependsOn: [], comments: PLAN, ...over };
}

// --- AC2: the three-term predicate --------------------------------------------

test('a ticket is fleet-ready only when all three terms hold', () => {
  const tickets = [ticket('#10')];
  const by = classifyFleet(tickets, new Map([['#10', 'Backlog']]), CONFIG);

  assert.deepEqual(by.get('#10'), { bucket: 'ready', criteria: 1 });
});

test('the rung term: a ticket off the first rung is bucketed by where it sits', () => {
  const tickets = [ticket('#10'), ticket('#11'), ticket('#12')];
  const states = new Map([
    ['#10', 'In Progress'],
    ['#11', 'In Review'],
    ['#12', 'Done'],
  ]);

  const by = classifyFleet(tickets, states, CONFIG);

  assert.equal(by.get('#10').bucket, 'in progress');
  assert.equal(by.get('#11').bucket, 'review');
  assert.equal(by.get('#12').bucket, 'done');
  for (const id of ['#10', '#11', '#12']) assert.equal(by.get(id).term, 'rung', id);
});

test('the rung term: a state that is not on the ladder is never a candidate', () => {
  const tickets = [ticket('#10'), ticket('#11')];
  const states = new Map([['#10', 'Staging']]); // #11 has no state at all

  const by = classifyFleet(tickets, states, CONFIG);

  assert.equal(by.get('#10').bucket, 'unknown');
  assert.equal(by.get('#10').term, 'state');
  assert.match(by.get('#10').why, /Staging.*ladder/);
  assert.equal(by.get('#11').bucket, 'unknown');
  assert.equal(by.get('#11').term, 'state');
});

test('the dependency term: a ticket waiting on anything not done is blocked, and names it', () => {
  const tickets = [ticket('#10', { dependsOn: ['#8', '#9'] })];
  const states = new Map([
    ['#10', 'Backlog'],
    ['#8', 'Done'],
    ['#9', 'In Review'],
  ]);

  const by = classifyFleet(tickets, states, CONFIG);

  assert.equal(by.get('#10').bucket, 'blocked');
  assert.equal(by.get('#10').term, 'dependencies');
  assert.deepEqual(by.get('#10').waitsOn, ['#9']);
});

test('the plan term: a ticket with no ## Plan comment is unplanned, not ready', () => {
  const tickets = [
    ticket('#10', { comments: [] }),
    ticket('#11', { comments: [{ author: 'a', at: null, body: 'sounds good, but no plan here' }] }),
    ticket('#12', { comments: [{ author: 'a', at: null, body: 'nothing' }, ...PLAN] }),
  ];
  const states = new Map([
    ['#10', 'Backlog'],
    ['#11', 'Backlog'],
    ['#12', 'Backlog'],
  ]);

  const by = classifyFleet(tickets, states, CONFIG);

  for (const id of ['#10', '#11']) {
    assert.equal(by.get(id).bucket, 'unplanned', id);
    assert.equal(by.get(id).term, 'plan', id);
    assert.match(by.get(id).why, /## Plan/);
  }
  assert.equal(by.get('#12').bucket, 'ready');
});

test('the plan term: a plan comment or a body criteria section each count as planned; neither does not (#153)', () => {
  const tickets = [
    ticket('#10', { body: '## Problem\n\nno criteria in the body\n' }),
    ticket('#11', {
      comments: [],
      body: '## Problem\n\nfiled by split\n\n## Acceptance criteria\n\n- [ ] AC1: one\n- [ ] AC2: two\n',
    }),
    ticket('#12', { comments: [{ author: 'a', at: null, body: 'no plan here' }], body: '## Problem\n\nnothing\n' }),
  ];
  const states = new Map([
    ['#10', 'Backlog'],
    ['#11', 'Backlog'],
    ['#12', 'Backlog'],
  ]);

  const by = classifyFleet(tickets, states, CONFIG);

  assert.deepEqual(by.get('#10'), { bucket: 'ready', criteria: 1 }, 'a plan comment only');
  assert.deepEqual(by.get('#11'), { bucket: 'ready', criteria: 2 }, 'a criteria section only');
  assert.equal(by.get('#12').bucket, 'unplanned', 'neither');
  assert.equal(by.get('#12').term, 'plan');
  assert.match(by.get('#12').why, /## Plan/);
  assert.match(by.get('#12').why, /## Acceptance criteria/);
});

test('the terms are reported in a fixed order, so one ticket fails one named term', () => {
  const tickets = [ticket('#10', { dependsOn: ['#9'], comments: [] })];
  const states = new Map([['#10', 'Backlog'], ['#9', 'Backlog']]);

  const by = classifyFleet(tickets, states, CONFIG);

  assert.equal(by.get('#10').term, 'dependencies');
});

test('the plan term: the newest plan is the one dated last, not the one listed last', () => {
  const first = { author: 'a', at: '2026-09-01T10:00:00Z', body: '## Plan\n\n- [ ] AC1: first\n' };
  const revised = { author: 'a', at: '2026-09-02T10:00:00Z', body: '## Plan\n\n- [ ] AC1: revised\n' };
  const undated = { author: 'a', at: null, body: '## Plan\n\n- [ ] AC1: undated\n' };

  assert.equal(planOf([revised, first]), revised.body, 'a tracker listing comments out of order');
  assert.equal(planOf([first, revised]), revised.body);
  assert.equal(planOf([revised, undated]), revised.body, 'a dated plan outranks an undated one');
  assert.equal(planOf([{ ...undated, body: '## Plan\nolder' }, undated]), undated.body, 'with no dates, the later one');
});

// --- AC3: the quick-wins order ------------------------------------------------

const CANDIDATES = [
  { id: '#10', type: 'Feature', criteria: 3 },
  { id: '#11', type: 'Bug', criteria: 3 },
  { id: '#12', type: 'Feature', criteria: 1 },
  { id: '#13', type: 'Task', criteria: 3 },
];

test('candidates are ordered by criteria count ascending, then fix before feat', () => {
  assert.deepEqual(orderCandidates(CANDIDATES, CONFIG), ['#12', '#11', '#13', '#10']);
});

test('the order is stable: an equal pair keeps the order it came in', () => {
  const pair = [
    { id: '#20', type: 'Feature', criteria: 2 },
    { id: '#21', type: 'Feature', criteria: 2 },
  ];
  assert.deepEqual(orderCandidates(pair, CONFIG), ['#20', '#21']);
  assert.deepEqual(orderCandidates([...pair].reverse(), CONFIG), ['#21', '#20']);
});

test('an explicit ID list is used verbatim — not reordered, not filtered', () => {
  const explicit = ['#10', '#12', '#99'];
  assert.deepEqual(orderCandidates(CANDIDATES, CONFIG, { explicit }), explicit);
  assert.deepEqual(orderCandidates(CANDIDATES, CONFIG, { explicit: [] }), [], 'an empty list is a list, not an omitted one');
});

test('an unmapped type is ordered, not refused: it sits between fix and feat', () => {
  const mixed = [
    { id: '#30', type: 'Feature', criteria: 1 },
    { id: '#31', type: 'Epic', criteria: 1 },
    { id: '#32', type: 'Bug', criteria: 1 },
    { id: '#33', type: null, criteria: 1 },
  ];
  assert.deepEqual(orderCandidates(mixed, CONFIG), ['#32', '#31', '#33', '#30']);
});

test('the criteria count comes from the plan\'s Criteria section, not its Verification list', () => {
  const plan = [
    '## Plan',
    '### Criteria',
    '- [ ] AC1: one',
    '- [x] AC2: two',
    '### Verification',
    '- [ ] npm test',
    '- [ ] a real run',
  ].join('\n');

  assert.equal(countCriteria(plan), 2);
  assert.equal(countCriteria('## Plan\n\n- [ ] AC1: one\n- [ ] AC2: two\n- [ ] AC3: three\n'), 3);
  assert.equal(countCriteria(''), 0);
});

test('selectFleet prints one order over the ready tickets, and nothing else', () => {
  const plan = (n) => [{
    author: 'a',
    at: null,
    body: `## Plan\n### Criteria\n${Array.from({ length: n }, (_, i) => `- [ ] AC${i + 1}: x`).join('\n')}\n`,
  }];
  const tickets = [
    { id: '#10', type: 'Feature', dependsOn: [], comments: plan(3) },
    { id: '#11', type: 'Bug', dependsOn: [], comments: plan(3) },
    { id: '#12', type: 'Feature', dependsOn: [], comments: plan(1) },
    { id: '#13', type: 'Feature', dependsOn: [], comments: [] },
    { id: '#14', type: 'Feature', dependsOn: [], comments: plan(1) },
  ];
  const states = new Map([['#10', 'Backlog'], ['#11', 'Backlog'], ['#12', 'Backlog'], ['#13', 'Backlog'], ['#14', 'In Progress']]);

  const { by, order } = selectFleet(tickets, states, CONFIG);

  assert.deepEqual(order, ['#12', '#11', '#10']);
  assert.equal(by.get('#13').bucket, 'unplanned');
  assert.equal(by.get('#14').bucket, 'in progress');

  assert.deepEqual(selectFleet(tickets, states, CONFIG, { explicit: ['#14', '#10'] }).order, ['#14', '#10']);
  assert.deepEqual(selectFleet(tickets, states, CONFIG, { explicit: [] }).order, []);
});
