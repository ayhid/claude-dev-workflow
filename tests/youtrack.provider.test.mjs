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
