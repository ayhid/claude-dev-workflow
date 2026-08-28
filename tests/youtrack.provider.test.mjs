/**
 * The YouTrack adapter against the provider contract.
 *
 * Offline by construction: the adapter takes its `fetch` as an argument, so
 * this drives a small in-memory YouTrack rather than stubbing a global. That is
 * determinism rule 1, and it is what lets the same contract suite run against a
 * CLI-backed adapter that has no `fetch` at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createYouTrackProvider, normalizeIssue } from '../lib/youtrack.mjs';
import { UNKNOWN } from '../lib/sync.mjs';
import { runContractSuite } from './provider.contract.mjs';

const CONFIG = {
  provider: 'youtrack',
  baseUrl: 'https://acme.invalid',
  project: 'ABC',
  projectId: '0-1',
  states: { start: 'In Progress', review: 'In Review', done: 'Done', ladder: [] },
};

/**
 * A fake YouTrack holding real state, so a write is observable by the next
 * read — which is the only way to test the read-back rule honestly.
 */
function fakeYouTrack({ fail = false } = {}) {
  const issues = new Map([
    ['ABC-1', { state: 'In Progress', summary: 'First', description: 'A body' }],
    ['ABC-2', { state: 'In Review', summary: 'Second', description: '' }],
  ]);

  const fetchImpl = async (url, init = {}) => {
    if (fail) return new Response('upstream exploded', { status: 500 });

    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '');
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

    const asIssue = (id) => {
      const i = issues.get(id);
      if (!i) return null;
      return {
        idReadable: id,
        summary: i.summary,
        description: i.description,
        customFields: [
          { name: 'State', value: { name: i.state } },
          { name: 'Assignee', value: { login: 'ayoub' } },
          { name: 'Priority', value: { name: 'Major' } },
          { name: 'Estimation', value: { minutes: 90 } },
        ],
        comments: [{ text: 'a comment', created: 1735689600000, author: { login: 'someone' } }],
      };
    };

    if (init.method === 'POST' && path === 'api/commands') {
      const body = JSON.parse(init.body);
      const m = /^State (?:\{(.+)\}|(\S+))$/.exec(body.query);
      const wanted = m?.[1] ?? m?.[2];
      const id = body.issues[0].idReadable;
      // The behaviour that makes rule 3 necessary: unknown states are accepted
      // with a 200 and silently do nothing.
      if (wanted && issues.has(id) && ['In Progress', 'In Review', 'Done'].includes(wanted)) {
        issues.get(id).state = wanted;
      }
      return json({});
    }

    if (init.method === 'POST' && /^api\/issues\/[^/]+\/comments$/.test(path)) return json({ id: 'c-1' });
    if (init.method === 'POST' && path === 'api/issues') {
      issues.set('ABC-9', { state: 'In Progress', summary: 'New', description: '' });
      return json({ idReadable: 'ABC-9' });
    }

    if (path === 'api/users/me') return json({ login: 'ayoub' });
    if (path === 'api/admin/projects') return json([{ id: '0-1', shortName: 'ABC', name: 'Acme' }]);

    if (path === 'api/issues') {
      const query = u.searchParams.get('query') ?? '';
      const ids = [...query.matchAll(/issue id: (\S+)/g)].map((x) => x[1]);
      if (ids.length) return json(ids.map(asIssue).filter(Boolean));
      return json([...issues.keys()].map(asIssue));
    }

    const single = /^api\/issues\/([^/]+)$/.exec(path);
    if (single) {
      const issue = asIssue(single[1]);
      return issue ? json(issue) : json({ error: 'not found' }, 404);
    }

    return json({ error: `unhandled ${path}` }, 404);
  };

  return { fetchImpl, issues };
}

const build = ({ fail = false } = {}) => {
  const warnings = [];
  const { fetchImpl } = fakeYouTrack({ fail });
  const r = createYouTrackProvider({
    config: CONFIG,
    fetch: fetchImpl,
    onWarn: (m) => warnings.push(m),
    env: { YOUTRACK_TOKEN: 'test-token' },
  });
  assert.ok(r.ok, r.error);
  return { provider: r.provider, warnings };
};

// The adapter resolves its token through lib/token.mjs, which reads the real
// environment. Setting it here keeps the whole suite offline.
process.env.YOUTRACK_TOKEN = 'test-token';

let lastWarnings = [];
runContractSuite('youtrack', {
  make: async () => {
    const b = build();
    lastWarnings = b.warnings;
    return b.provider;
  },
  makeFailing: async () => {
    const b = build({ fail: true });
    lastWarnings = b.warnings;
    return b.provider;
  },
  issueId: 'ABC-1',
  otherIssueId: 'ABC-2',
  startState: 'In Progress',
  doneState: 'Done',
  warnings: () => lastWarnings,
});

// --- YouTrack-specific behaviour the contract cannot express -------------------

test('setState refuses an off-ladder state before sending it', async () => {
  const { provider } = build();
  // 'Staging' is not on this project's ladder. Rule 2: catch it here, where the
  // error names the problem, rather than sending a command YouTrack accepts
  // with a 200 and silently ignores.
  const r = await provider.setState('ABC-1', 'Staging');
  assert.equal(r.ok, false);
  assert.match(r.error, /not on the ladder/);
  assert.equal(await provider.getState('ABC-1'), 'In Progress', 'and nothing was changed');
});

test('the commands API lying is still caught by the read-back', async () => {
  const { provider } = build();
  // `raw` deliberately bypasses ladder validation — it is the escape hatch for
  // YouTrack's native DSL. The read-back is the only thing standing between a
  // silently-ignored command and a false "done", which is why rule 3 applies
  // to every write path and not just the validated one.
  const r = await provider.raw('ABC-1', 'State Staging');
  assert.ok(r.ok, 'the HTTP call itself succeeded');
  assert.equal(r.state, 'In Progress', 'but the state reported is the one actually found');
});

test('normalizeIssue renders every YouTrack value shape', () => {
  const i = normalizeIssue(
    {
      idReadable: 'ABC-3',
      summary: 'T',
      description: 'D',
      customFields: [
        { name: 'State', value: { name: 'Done' } },
        { name: 'Assignee', value: { login: 'ayoub', fullName: 'Ayoub' } },
        { name: 'Estimation', value: { minutes: 45 } },
        { name: 'Tags', value: [{ name: 'a' }, { name: 'b' }] },
        { name: 'Empty', value: null },
      ],
      comments: [{ text: 'hi', created: 1735689600000, author: { login: 'x' } }],
    },
    { baseUrl: 'https://acme.invalid' },
  );

  assert.equal(i.state, 'Done');
  assert.equal(i.assignee, 'ayoub');
  assert.equal(i.url, 'https://acme.invalid/issue/ABC-3');
  assert.deepEqual(
    i.fields,
    [
      { name: 'Estimation', value: '45m' },
      { name: 'Tags', value: 'a, b' },
    ],
    'sorted, rendered, and unset fields dropped',
  );
  assert.equal(i.comments[0].at, '2025-01-01T00:00:00.000Z', 'epoch ms became ISO-8601');
});

test('an issue with no State reads as UNKNOWN, not as a missing field', () => {
  const i = normalizeIssue({ idReadable: 'ABC-4', customFields: [] });
  assert.equal(i.state, UNKNOWN);
});

// --- #14: converging on an instance whose brace rule we do not know -----------
//
// #14 found an instance that rejects `State {In Review}` and applies
// `State In Review`; the fake above is the opposite, requiring the braces. Which
// is the general rule could not be settled without a live YouTrack, so `setState`
// does not need to know: it tries both spellings and stops at the one that moved
// the ticket. These two tests are that claim, one dialect each.

/**
 * A YouTrack that accepts exactly one spelling of a State command.
 *
 * @param {'bare'|'braced'|'neither'|'silent'} dialect which spelling this
 *   instance applies. `neither` rejects both; `silent` is the other documented
 *   failure — 200 for a command it did not apply.
 * @param {{localised?: boolean}} [opts] report state names in French, as the
 *   instance in #14 did, so nothing may compare a read-back against the config
 */
function pickyYouTrack(dialect, { localised = false } = {}) {
  const FR = { 'In Progress': 'En cours', 'In Review': 'En revue', Done: 'Terminé' };
  const commands = [];
  let state = 'In Progress';

  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\//, '');
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

    if (init.method === 'POST' && path === 'api/commands') {
      const body = JSON.parse(init.body);
      commands.push(body);
      const braced = /^State \{(.+)\}$/.exec(body.query);
      const bare = /^State (.+)$/.exec(body.query);
      const wanted = braced ? braced[1] : bare?.[1];
      const accepts = { bare: !braced, braced: Boolean(braced), neither: false, silent: true }[dialect];
      if (!accepts) {
        return json({ error_description: `État expected: ${body.query.slice(6)}` }, 400);
      }
      if (dialect !== 'silent' && ['In Progress', 'In Review', 'Done'].includes(wanted)) state = wanted;
      return json({});
    }

    if (path.startsWith('api/issues/')) {
      const name = localised ? (FR[state] ?? state) : state;
      return json({ customFields: [{ name: 'State', value: { name } }] });
    }
    return json({}, 404);
  };

  return { fetchImpl, commands, current: () => state };
}

const buildPicky = (...args) => {
  const fake = pickyYouTrack(...args);
  const r = createYouTrackProvider({ config: CONFIG, fetch: fake.fetchImpl, onWarn: () => {} });
  assert.ok(r.ok, r.error);
  return { provider: r.provider, ...fake };
};

test('setState moves a multi-word state on an instance that rejects braces', async () => {
  const { provider, commands, current } = buildPicky('bare');
  const r = await provider.setState('ABC-1', 'review');

  assert.equal(r.ok, true, r.error);
  assert.equal(r.state, 'In Review');
  assert.equal(current(), 'In Review');
  assert.deepEqual(commands.map((c) => c.query), ['State In Review'], 'the bare spelling leads, so no retry was needed');
});

test('setState retries the braced spelling on an instance that requires it', async () => {
  const { provider, commands, current } = buildPicky('braced');
  const r = await provider.setState('ABC-1', 'review');

  assert.equal(r.ok, true, r.error);
  assert.equal(r.state, 'In Review');
  assert.equal(current(), 'In Review');
  assert.deepEqual(commands.map((c) => c.query), ['State In Review', 'State {In Review}']);
});

test('a rejected attempt posts no comment, so the retry still carries it', async () => {
  // A 400 accepted nothing, the comment included. Dropping it here would lose
  // the comment entirely on every instance that needs the second spelling.
  const { provider, commands } = buildPicky('braced');
  await provider.setState('ABC-1', 'review', 'moving to review');
  assert.deepEqual(commands.map((c) => c.comment), ['moving to review', 'moving to review']);
});

test('a 200 that changed nothing still posted the comment, so the retry drops it', async () => {
  // The other failure mode: accepted, applied nothing. The comment rode along
  // with that 200, and sending it again would double-post it on the ticket.
  const { provider, commands } = buildPicky('silent');
  await provider.setState('ABC-1', 'review', 'moving to review');
  assert.deepEqual(commands.map((c) => c.comment), ['moving to review', undefined]);
});

test('setState judges a write by what changed, not by the name it reads back', async () => {
  // #14's instance reported `État`. A localised state name can never equal the
  // configured English one, so comparing the two would report every successful
  // move as a failure.
  const { provider } = buildPicky('bare', { localised: true });
  const r = await provider.setState('ABC-1', 'review');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state, 'En revue', 'rule 3: the state found, not the one asked for');
});

test('setState reports failure when no spelling moves the ticket', async () => {
  const { provider } = buildPicky('neither');
  const r = await provider.setState('ABC-1', 'review');
  assert.equal(r.ok, false, 'this is what makes `start` print NOT MOVED with a reason');
  assert.match(r.error, /État expected/);
});

test('setState succeeds when the ticket is already on the target state', async () => {
  // Nothing changes, so "unchanged" cannot mean "did not apply" here.
  const { provider } = buildPicky('bare');
  const r = await provider.setState('ABC-1', 'start');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state, 'In Progress');
});
