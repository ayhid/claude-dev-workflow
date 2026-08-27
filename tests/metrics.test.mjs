/**
 * The transition log (#28): its format, its arithmetic, and its refusal to
 * ever be the reason a ticket did not close.
 *
 * Pure by design, so the clock is a parameter and the same event always renders
 * the same bytes. The last section runs the real CLI against the shared `gh`
 * stub, because the claim that matters — every command that moves a ticket
 * records it, without any of them knowing that a log exists — is a claim about
 * the wiring and cannot be asserted any other way.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, deepMerge } from '../lib/config.mjs';
import {
  closeEvent,
  currentCycle,
  elapsedSince,
  metricsEnabled,
  metricsFileOf,
  parseCriteria,
  parseLog,
  renderEvent,
  roleOf,
  startsSince,
} from '../lib/metrics.mjs';
import { CONFIG, withStubGh } from './ghstub.mjs';

const config = deepMerge(DEFAULTS, {
  states: { start: 'In Progress', review: 'In Review', done: 'Done', abandon: 'Backlog' },
});

const AT = new Date('2026-08-27T09:00:00.000Z');
const at = (iso) => new Date(iso);

// --- which transitions count -----------------------------------------------

test('a state is classified by rung, never by the backend that produced it', () => {
  assert.equal(roleOf(config, 'In Progress'), 'start');
  assert.equal(roleOf(config, 'Done'), 'done');
  assert.equal(roleOf(config, 'Backlog'), 'abandon');
});

test('a state with no rung is not an event, and neither is no state', () => {
  // Parked in Blocked, or moved by hand to something the project never named:
  // the reconciler leaves those alone and so does this.
  assert.equal(roleOf(config, 'In Review'), null, 'review is not a start, a close or a giving-up');
  assert.equal(roleOf(config, 'Blocked'), null);
  assert.equal(roleOf(config, null), null);
  assert.equal(roleOf({ states: {} }, 'Done'), null);
});

test('a project pointing two rungs at one state gets the more significant one', () => {
  const odd = deepMerge(DEFAULTS, { states: { start: 'Open', abandon: 'Open', done: 'Open' } });
  assert.equal(roleOf(odd, 'Open'), 'done');
});

// --- the line ----------------------------------------------------------------

test('an event renders the same bytes every time, keys in a fixed order', () => {
  const line = renderEvent({ role: 'start', id: '#12', state: 'In Progress', at: AT, provider: 'github' });
  assert.equal(
    line,
    '{"at":"2026-08-27T09:00:00.000Z","event":"start","id":"#12","state":"In Progress","provider":"github"}\n',
  );
  assert.equal(line, renderEvent({ provider: 'github', state: 'In Progress', id: '#12', role: 'start', at: AT }));
});

test('the measured fields appear on a close and not on a start', () => {
  const start = JSON.parse(renderEvent({ role: 'start', id: '#12', state: 'In Progress', at: AT }));
  assert.equal('elapsedMs' in start, false, 'nothing is elapsed at the beginning');

  const done = JSON.parse(renderEvent({ role: 'done', id: '#12', state: 'Done', at: AT, elapsedMs: 5, starts: 1 }));
  assert.deepEqual([done.elapsedMs, done.starts, done.criteria], [5, 1, null]);

  // Abandoned work is measured like finished work, but it has no criteria to
  // have passed: a field that is always null is worse than no field.
  const dropped = JSON.parse(renderEvent({ role: 'abandon', id: '#12', state: 'Backlog', at: AT, starts: 2 }));
  assert.equal('criteria' in dropped, false);
  assert.equal(dropped.starts, 2);
});

test('an unmeasured field is null, never zero', () => {
  const done = JSON.parse(renderEvent({ role: 'done', id: '#12', state: 'Done', at: AT }));
  assert.equal(done.elapsedMs, null, '0 would read as "measured, and instant"');
});

test('a nonsense event is refused rather than written', () => {
  assert.throws(() => renderEvent({ role: 'reviewed', id: '#1', state: 'x' }), /unknown metrics role/);
  assert.throws(() => renderEvent({ role: 'done', id: '', state: 'x' }), /needs an issue ID/);
});

// --- reading a log that reality has been at ---------------------------------

test('a corrupt line is skipped and counted, never thrown', () => {
  const log = [
    '{"at":"2026-08-01T00:00:00.000Z","event":"start","id":"#1","state":"In Progress"}',
    'not json at all',
    '<<<<<<< HEAD',
    '{"at":"2026-08-02T00:00:00.000Z"}',
    '',
    '{"at":"2026-08-03T00:00:00.000Z","event":"done","id":"#1","state":"Done"}',
  ].join('\n');

  const { events, skipped } = parseLog(log);
  assert.equal(events.length, 2, 'the readable events still come back');
  assert.equal(skipped, 3, 'and the damage is counted rather than hidden');
  assert.deepEqual(parseLog(''), { events: [], skipped: 0 });
});

// --- the arithmetic ----------------------------------------------------------

const cycle = [
  { at: '2026-08-01T09:00:00.000Z', event: 'start', id: '#1', state: 'In Progress' },
  { at: '2026-08-02T09:00:00.000Z', event: 'done', id: '#1', state: 'Done' },
  { at: '2026-08-10T09:00:00.000Z', event: 'start', id: '#1', state: 'In Progress' },
  { at: '2026-08-11T09:00:00.000Z', event: 'start', id: '#1', state: 'In Progress' },
  { at: '2026-08-05T09:00:00.000Z', event: 'start', id: '#2', state: 'In Progress' },
];

test('a reopened ticket is measured over its current cycle, not its whole life', () => {
  assert.deepEqual(currentCycle(cycle, '#1').map((e) => e.at), [
    '2026-08-10T09:00:00.000Z',
    '2026-08-11T09:00:00.000Z',
  ]);
  assert.equal(startsSince(cycle, '#1'), 2, 'restarted once since it was last closed');
  assert.equal(elapsedSince(cycle, '#1', at('2026-08-12T09:00:00.000Z')), 2 * 86_400_000);
});

test('a ticket nobody started here has no elapsed time, and does not borrow one', () => {
  // What `sync` closing somebody else's work looks like. Deriving a start from
  // the branch or the ticket history would be a guess dressed as a measurement.
  assert.equal(elapsedSince(cycle, '#99', AT), null);
  assert.equal(startsSince(cycle, '#99'), 0);
  assert.equal(elapsedSince([{ at: 'nonsense', event: 'start', id: '#3' }], '#3', AT), null);
});

test('one ticket never measures another', () => {
  assert.equal(startsSince(cycle, '#2'), 1);
  assert.equal(elapsedSince(cycle, '#2', at('2026-08-06T09:00:00.000Z')), 86_400_000);
});

test('closeEvent assembles the three fields in one place', () => {
  const line = JSON.parse(
    closeEvent({
      events: cycle,
      role: 'done',
      id: '#1',
      state: 'Done',
      at: at('2026-08-12T09:00:00.000Z'),
      provider: 'github',
      criteria: 'first-pass',
    }),
  );
  assert.deepEqual(
    [line.elapsedMs, line.starts, line.criteria],
    [2 * 86_400_000, 2, 'first-pass'],
  );
});

// --- the flag ----------------------------------------------------------------

test('criteria takes two values, and a typo is refused by name', () => {
  assert.deepEqual(parseCriteria('first-pass'), { ok: true, criteria: 'first-pass' });
  assert.deepEqual(parseCriteria(undefined), { ok: true, criteria: null }, 'unanswered, not false');
  const bad = parseCriteria('firstpass');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /first-pass or reworked/);
});

// --- the switches --------------------------------------------------------------

test('metrics are on unless a project turns them off', () => {
  assert.equal(metricsEnabled({}), true);
  assert.equal(metricsEnabled({ metrics: false }), false);
  assert.equal(metricsFileOf({}), '.dev-workflow.metrics.jsonl');
  assert.equal(metricsFileOf({ metricsFile: 'x.jsonl' }), 'x.jsonl');
});

// --- every command that moves a ticket, through the real CLI --------------------

const LOG = (repo) => join(repo, '.dev-workflow.metrics.jsonl');
const lines = (repo) =>
  readFileSync(LOG(repo), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a start and a close are recorded, and the close carries what it measured', async () => {
  const { repo, dev } = await withStubGh({ labels: '' });

  const started = await dev(['resume', '#12']);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, /created .*metrics\.jsonl/, 'say so once, rather than editing .gitignore');

  const closed = await dev(['update', '#12', 'state', 'done', '--criteria', 'first-pass']);
  assert.equal(closed.code, 0, closed.stderr);

  const [start, done] = lines(repo);
  assert.deepEqual([start.event, start.id, start.state], ['start', '#12', 'In Progress']);
  assert.equal(start.provider, 'github');
  assert.deepEqual([done.event, done.state, done.starts, done.criteria], ['done', 'Done', 1, 'first-pass']);
  assert.ok(done.elapsedMs >= 0, 'elapsed is measured from the start this log recorded');
});

test('abandoning is recorded too — a log of successes answers nothing', async () => {
  const { repo, dev } = await withStubGh();
  await dev(['abandon', '#12', 'superseded', '--force']);

  const [event] = lines(repo);
  assert.deepEqual([event.event, event.state, event.starts], ['abandon', 'Backlog', 0]);
  assert.equal('criteria' in event, false);
});

test('the rung is read off the state that came back, not the one asked for', async () => {
  // `sync` passes a ladder state rather than a rung, and a tracker can refuse
  // what it was asked. Only the state read back is evidence of anything.
  const { repo, dev } = await withStubGh({ labels: '' });
  await dev(['update', '#12', 'state', 'In Review']);
  assert.equal(existsSync(LOG(repo)), false, 'review is not a rung this log records');

  await dev(['update', '#12', 'state', 'In Progress']);
  assert.deepEqual(lines(repo).map((e) => e.event), ['start']);
});

test('metrics: false writes nothing at all', async () => {
  const { repo, dev } = await withStubGh({ config: { ...CONFIG, metrics: false } });
  const r = await dev(['update', '#12', 'state', 'done']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(LOG(repo)), false);
});

test('a log that cannot be written never fails the ticket transition', async () => {
  // The instrument must not break the thing it measures. A directory where the
  // file should be is the cheapest way to make every append fail.
  const { repo, dev } = await withStubGh();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(LOG(repo));

  const r = await dev(['update', '#12', 'state', 'done']);
  assert.equal(r.code, 0, 'the close still succeeded');
  assert.match(r.stdout, /State is now: Done/);
  assert.match(r.stderr, /could not record the transition of #12/, 'and it said so rather than silently');
});

test('a corrupt log is appended to, never rewritten', async () => {
  const { repo, dev } = await withStubGh();
  writeFileSync(LOG(repo), 'half a line that never fini\n');

  const r = await dev(['update', '#12', 'state', 'done']);
  assert.equal(r.code, 0, r.stderr);

  const raw = readFileSync(LOG(repo), 'utf8');
  assert.match(raw, /^half a line that never fini\n/, 'somebody may want to recover that by hand');
  const { events, skipped } = parseLog(raw);
  assert.deepEqual([events.length, skipped], [1, 1]);
});

test('a line truncated mid-write does not swallow the next event', async () => {
  // A process killed during an append leaves a line with no newline on it.
  // Appending straight onto that would join the two, and the new event — the
  // one that is not damaged — would be the one lost.
  const { repo, dev } = await withStubGh();
  writeFileSync(LOG(repo), '{"at":"2026-01-01T00:00:00.000Z","event":"start","id":"#12"');

  const r = await dev(['update', '#12', 'state', 'done']);
  assert.equal(r.code, 0, r.stderr);

  const { events, skipped } = parseLog(readFileSync(LOG(repo), 'utf8'));
  assert.deepEqual([events.length, skipped], [1, 1], 'the good event survived the damaged one');
  assert.equal(events[0].event, 'done');
});

test('a bad --criteria is refused before the tracker is touched', async () => {
  const { repo, dev, read } = await withStubGh();
  const r = await dev(['update', '#12', 'state', 'done', '--criteria', 'yes']);

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /first-pass or reworked/);
  assert.doesNotMatch(read('log'), /issue edit/, 'nothing was written to the tracker');
  assert.equal(existsSync(LOG(repo)), false);
});
