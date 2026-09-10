/**
 * Board-level selection, with no I/O in it (#146).
 *
 * Every case here is a plain object: the selector never reads a file, spawns
 * git or reaches the tracker, so the whole of what `dev.mjs fleet` will decide
 * is decidable in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFleet } from '../lib/fleet.mjs';

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

test('the terms are reported in a fixed order, so one ticket fails one named term', () => {
  const tickets = [ticket('#10', { dependsOn: ['#9'], comments: [] })];
  const states = new Map([['#10', 'Backlog'], ['#9', 'Backlog']]);

  const by = classifyFleet(tickets, states, CONFIG);

  assert.equal(by.get('#10').term, 'dependencies');
});
