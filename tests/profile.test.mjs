/**
 * The token profiler (repo-local dev tooling, not shipped).
 *
 * What is worth pinning is the *weighting*, because that is the whole reason
 * the tool exists: raw token counts rank the cheapest thing first, and a report
 * that did so would send every optimisation at output length, which is a tenth
 * of the bill.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, deepMerge } from '../lib/config.mjs';
import { byTicket, costOf, cutoffFor, foldSession, priceKey, transcriptDirFor, weigh, WEIGHTS } from '../tools/profile.mjs';

const config = deepMerge(DEFAULTS, { provider: 'github', github: { repo: 'o/r' } });

const usage = (patch = {}) => ({
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  ...patch,
});

const assistant = (patch = {}, u = usage()) => ({
  type: 'assistant',
  timestamp: '2026-08-28T09:00:00.000Z',
  message: { model: 'claude-opus-5', usage: u, content: [] },
  ...patch,
});

// --- weighting -------------------------------------------------------------------

test('a cached read is worth a tenth of an input token, and output five', () => {
  assert.equal(weigh(usage({ input_tokens: 100 })), 100);
  assert.equal(weigh(usage({ cache_read_input_tokens: 100 })), 10);
  assert.equal(weigh(usage({ cache_creation_input_tokens: 100 })), 125);
  assert.equal(weigh(usage({ output_tokens: 100 })), 500);
});

test('weighting reorders what raw counts would rank first', () => {
  // 1M cached reads look enormous and cost less than 25k output tokens. Ranking
  // by raw tokens would send every optimisation at the wrong thing.
  const reads = weigh(usage({ cache_read_input_tokens: 1_000_000 }));
  const out = weigh(usage({ output_tokens: 25_000 }));
  assert.ok(out > out * 0, 'sanity');
  assert.equal(reads, 100_000);
  assert.equal(out, 125_000);
  assert.ok(out > reads, 'the smaller raw number is the larger cost');
});

test('an unpriced model reports null rather than a plausible number', () => {
  assert.equal(costOf(usage({ input_tokens: 1_000_000 }), 'claude-opus-5'), 5);
  assert.equal(costOf(usage({ output_tokens: 1_000_000 }), 'claude-opus-5'), 25);
  assert.equal(costOf(usage({ input_tokens: 1_000_000 }), 'some-future-model'), null);
});

test('every weight is declared, so none can be silently skipped', () => {
  assert.deepEqual(Object.keys(WEIGHTS).sort(), [
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'input_tokens',
    'output_tokens',
  ]);
});

// --- folding a transcript ----------------------------------------------------------

test('a session sums its usage, counts its turns and keeps its branch', () => {
  const s = foldSession([
    { type: 'user', gitBranch: 'feat/12-thing', timestamp: '2026-08-28T08:00:00.000Z' },
    assistant({}, usage({ output_tokens: 10, cache_read_input_tokens: 1000 })),
    assistant({ timestamp: '2026-08-28T10:00:00.000Z' }, usage({ output_tokens: 5 })),
  ]);

  assert.equal(s.turns, 2);
  assert.equal(s.totals.output_tokens, 15);
  assert.equal(s.totals.cache_read_input_tokens, 1000);
  assert.equal(s.branch, 'feat/12-thing');
  assert.equal(s.model, 'claude-opus-5');
  assert.deepEqual([s.first, s.last], ['2026-08-28T08:00:00.000Z', '2026-08-28T10:00:00.000Z']);
});

test('a detached HEAD is not mistaken for a branch name', () => {
  const s = foldSession([
    { type: 'user', gitBranch: 'feat/12-thing' },
    { type: 'user', gitBranch: 'HEAD' },
    assistant(),
  ]);
  assert.equal(s.branch, 'feat/12-thing');
});

test('subagent turns are counted — moving work into one does not make it free', () => {
  const s = foldSession([assistant(), assistant({ isSidechain: true })]);
  assert.equal(s.turns, 2);
  assert.equal(s.sidechainTurns, 1);
});

test('tool calls are tallied, busiest first', () => {
  const call = (name) => ({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: usage(), content: [{ type: 'tool_use', name }] },
  });
  const s = foldSession([call('Bash'), call('Bash'), call('Read')]);
  assert.deepEqual(s.tools, [['Bash', 2], ['Read', 1]]);
});

test('a turn with no usage block is not counted as a turn', () => {
  const s = foldSession([{ type: 'assistant', message: { content: [] } }, assistant()]);
  assert.equal(s.turns, 1);
});

test('an unknown model is named, not merely flagged', () => {
  // A blank in a cost report is only actionable if it says what it could not
  // price — otherwise the reader cannot fix it.
  const s = foldSession([assistant({ message: { model: 'mystery', usage: usage({ output_tokens: 1 }) } })]);
  assert.deepEqual(s.unknownModels, ['mystery']);
  assert.equal(s.usd, null);
});

test('a dated snapshot is the same model at the same price', () => {
  // Claude Code records whatever id the request used. Exact-match lookup
  // reported `claude-sonnet-4-5-20250929` as unpriced — a blank for no reason.
  assert.equal(priceKey('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(priceKey('claude-opus-5'), 'claude-opus-5');
  assert.equal(priceKey(null), '');
  assert.equal(costOf(usage({ input_tokens: 1_000_000 }), 'claude-opus-5-20260101'), 5);

  const s = foldSession([assistant({ message: { model: 'claude-opus-5-20260101', usage: usage() } })]);
  assert.deepEqual(s.unknownModels, [], 'and it is not reported as unknown');
});

// --- attribution --------------------------------------------------------------------

test('sessions are grouped by the ticket their branch names', () => {
  const rows = byTicket(
    [
      { branch: 'feat/12-thing', turns: 10, weighted: 100, usd: 1, totals: usage() },
      { branch: 'feat/12-thing', turns: 5, weighted: 50, usd: 0.5, totals: usage() },
      { branch: 'fix/13-other', turns: 1, weighted: 10, usd: 0.1, totals: usage() },
    ],
    { config },
  );

  assert.deepEqual(rows.map((r) => r.id), ['#12', '#13'], 'heaviest first');
  assert.deepEqual([rows[0].sessions, rows[0].turns, rows[0].weighted], [2, 15, 150]);
});

test('ticketless work is reported, not hidden', () => {
  // Dropping it would flatter every average in the report.
  const rows = byTicket([{ branch: 'main', turns: 3, weighted: 30, usd: 1, totals: usage() }], { config });
  assert.equal(rows[0].id, '(no ticket)');
  assert.equal(rows[0].turns, 3);
});

test('one unpriced session makes the whole ticket unpriced, not partly priced', () => {
  const rows = byTicket(
    [
      { branch: 'feat/12-a', turns: 1, weighted: 10, usd: 5, totals: usage() },
      { branch: 'feat/12-a', turns: 1, weighted: 10, usd: null, totals: usage() },
    ],
    { config },
  );
  assert.equal(rows[0].usdKnown, false);
});

test('the transition log is joined in, so cost sits beside time and rework', () => {
  const rows = byTicket([{ branch: 'feat/12-thing', turns: 9, weighted: 90, usd: 2, totals: usage() }], {
    config,
    metrics: [
      { id: '#12', event: 'start' },
      { id: '#12', event: 'done', elapsedMs: 7_200_000, starts: 2, criteria: 'reworked' },
      { id: '#99', event: 'done', elapsedMs: 1, starts: 1, criteria: 'first-pass' },
    ],
  });

  assert.deepEqual(
    [rows[0].outcome, rows[0].elapsedMs, rows[0].starts, rows[0].criteria],
    ['done', 7_200_000, 2, 'reworked'],
  );
});

test('a ticket the log knows nothing about reports nulls, not zeros', () => {
  const rows = byTicket([{ branch: 'feat/12-thing', turns: 1, weighted: 1, usd: 1, totals: usage() }], { config });
  assert.deepEqual([rows[0].outcome, rows[0].elapsedMs, rows[0].criteria], [null, null, null]);
});

// --- odds and ends ---------------------------------------------------------------------

test('the window uses the same vocabulary as the rest of the tool', () => {
  const now = new Date('2026-08-28T00:00:00.000Z');
  assert.equal(cutoffFor('7d', now), '2026-08-21T00:00:00.000Z');
  assert.equal(cutoffFor('48h', now), '2026-08-26T00:00:00.000Z');
  assert.equal(cutoffFor(null), null);
  assert.throws(() => cutoffFor('last tuesday'), /7d, 48h or 2w/);
});

test('the transcript directory is derived from the working directory', () => {
  assert.equal(
    transcriptDirFor('/home/user/claude-dev-workflow', '/root'),
    '/root/.claude/projects/-home-user-claude-dev-workflow',
  );
});
