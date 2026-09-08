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

import { createYouTrackProvider, fieldNames, normalizeIssue } from '../lib/youtrack.mjs';
import { UNKNOWN } from '../lib/sync.mjs';
import { runContractSuite } from './provider.contract.mjs';

const CONFIG = {
  provider: 'youtrack',
  baseUrl: 'https://acme.invalid',
  project: 'ABC',
  projectId: '0-1',
  youtrack: { subtaskLinkType: 'Subtask' },
  states: { start: 'In Progress', review: 'In Review', done: 'Done', ladder: [] },
};

/**
 * A fake YouTrack holding real state, so a write is observable by the next
 * read — which is the only way to test the read-back rule honestly.
 */
function fakeYouTrack({ fail = false, linkSilently = false } = {}) {
  const issues = new Map([
    ['ABC-1', { state: 'In Progress', summary: 'First', description: 'A body' }],
    ['ABC-2', { state: 'In Review', summary: 'Second', description: '' }],
  ]);
  // Subtask links, parent -> children. `linkSilently` models invariant 1: the
  // commands API answering 200 for a link it did not make.
  const subtasks = new Map();
  let nextNumber = 9;

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
        links: [
          {
            direction: 'OUTWARD',
            linkType: { name: 'Subtask' },
            // Newest first, deliberately: the adapter is what must sort.
            issues: [...(subtasks.get(id) ?? [])].reverse().map((c) => ({
              idReadable: c,
              summary: issues.get(c)?.summary,
              description: issues.get(c)?.description,
            })),
          },
          // The same type inward — what a child sees — must never count as a child.
          {
            direction: 'INWARD',
            linkType: { name: 'Subtask' },
            issues: [...subtasks.entries()].filter(([, kids]) => kids.includes(id)).map(([p]) => ({ idReadable: p, summary: issues.get(p)?.summary })),
          },
        ],
      };
    };

    if (init.method === 'POST' && path === 'api/commands') {
      const body = JSON.parse(init.body);
      const link = /^subtask of (\S+)$/.exec(body.query);
      if (link) {
        const child = body.issues[0].idReadable;
        if (!linkSilently && issues.has(link[1]) && issues.has(child)) {
          subtasks.set(link[1], [...(subtasks.get(link[1]) ?? []), child]);
        }
        return json({});
      }
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
      const body = JSON.parse(init.body);
      const id = `ABC-${nextNumber++}`;
      issues.set(id, { state: 'In Progress', summary: body.summary ?? 'New', description: body.description ?? '' });
      return json({ idReadable: id });
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

  return { fetchImpl, issues, subtasks };
}

const build = ({ fail = false, linkSilently = false, config = CONFIG } = {}) => {
  const warnings = [];
  const { fetchImpl, subtasks } = fakeYouTrack({ fail, linkSilently });
  const r = createYouTrackProvider({
    config,
    fetch: fetchImpl,
    onWarn: (m) => warnings.push(m),
    env: { YOUTRACK_TOKEN: 'test-token' },
  });
  assert.ok(r.ok, r.error);
  return { provider: r.provider, warnings, subtasks };
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

// --- subtasks (#103) -------------------------------------------------------------

test('createChild links with "subtask of <PARENT>" on the child and reads the parent back', async () => {
  const { provider, subtasks } = build();
  const r = await provider.createChild({ parent: 'ABC-1', summary: 'A unit', description: 'Depends on: ABC-2' });
  assert.ok(r.ok, r.error);
  assert.equal(r.id, 'ABC-9');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(subtasks.get('ABC-1'), ['ABC-9']);
});

test('a 200 that linked nothing is a warning naming the parent, not a silent success (invariant 1)', async () => {
  const { provider } = build({ linkSilently: true });
  const r = await provider.createChild({ parent: 'ABC-1', summary: 'A unit', description: '' });
  assert.ok(r.ok, r.error);
  assert.equal(r.id, 'ABC-9');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /ABC-9/);
  assert.match(r.warnings[0], /ABC-1/);
  assert.match(r.warnings[0], /200/);
});

test('children follows the outward link only, sorted, with the body', async () => {
  const { provider } = build();
  await provider.createChild({ parent: 'ABC-1', summary: 'Second', description: 'Depends on: ABC-9' });
  await provider.createChild({ parent: 'ABC-1', summary: 'First', description: '' });

  const parent = await provider.children('ABC-1');
  assert.deepEqual(
    parent.data.map((c) => [c.id, c.title, c.body]),
    [['ABC-9', 'Second', 'Depends on: ABC-9'], ['ABC-10', 'First', '']],
  );
  assert.equal(parent.data[0].url, 'https://acme.invalid/issue/ABC-9');

  const child = await provider.children('ABC-9');
  assert.deepEqual(child.data, [], 'the inward link is the parent, not a child');
});

test('rule 2: no configured link type is an error naming the key, not a guess', async () => {
  const { youtrack, ...rest } = CONFIG;
  void youtrack;
  const { provider } = build({ config: rest });
  const r = await provider.children('ABC-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /youtrack\.subtaskLinkType/);
});

// --- #58: an instance whose *field* is localised, not just its values ----------
//
// #14's instance did not only report `En revue` for the state: the field itself
// is called `État`. Every read that looks a field up by the English name misses,
// returns UNKNOWN, and `setState` — which judges a write by the state changing —
// then sees UNKNOWN before and UNKNOWN after and reports every successful move
// as a failure. The field name is config, never a guess (rule 2), and every read
// goes through one accessor so an eighth call site cannot spell it again.

const LOCALISED_CONFIG = {
  ...CONFIG,
  youtrack: { ...CONFIG.youtrack, stateField: 'État', assigneeField: 'Responsable' },
};

/**
 * A YouTrack whose State field is `État` and whose Assignee is `Responsable`.
 *
 * Same shape as `fakeYouTrack`, but the commands API only understands
 * `État X` — which is exactly what a localised instance does with `State X`:
 * it does not know the field, and the read-back is what catches it.
 */
function localisedYouTrack() {
  const issues = new Map([
    ['ABC-1', { state: 'In Progress', summary: 'First' }],
    ['ABC-2', { state: 'In Review', summary: 'Second' }],
  ]);
  const commands = [];

  const asIssue = (id) => {
    const i = issues.get(id);
    if (!i) return null;
    return {
      idReadable: id,
      summary: i.summary,
      description: '',
      customFields: [
        { name: 'État', value: { name: i.state } },
        { name: 'Responsable', value: { login: 'ayoub', fullName: 'Ayoub' } },
        { name: 'Priorité', value: { name: 'Majeure' } },
      ],
      comments: [],
    };
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '');
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

    if (init.method === 'POST' && path === 'api/commands') {
      const body = JSON.parse(init.body);
      commands.push(body.query);
      const m = /^État (?:\{(.+)\}|(.+))$/.exec(body.query);
      if (!m) return json({ error_description: `Unknown field: ${body.query.split(' ')[0]}` }, 400);
      const wanted = m[1] ?? m[2];
      const id = body.issues[0].idReadable;
      if (issues.has(id) && ['In Progress', 'In Review', 'Done'].includes(wanted)) issues.get(id).state = wanted;
      return json({});
    }

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

  return { fetchImpl, issues, commands };
}

const buildLocalised = (config = LOCALISED_CONFIG) => {
  const fake = localisedYouTrack();
  const r = createYouTrackProvider({ config, fetch: fake.fetchImpl, onWarn: () => {} });
  assert.ok(r.ok, r.error);
  return { provider: r.provider, ...fake };
};

test('#58: setState on a localised field reports the move it made, not UNKNOWN', async () => {
  const { provider, commands, issues } = buildLocalised();
  const r = await provider.setState('ABC-1', 'review');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state, 'In Review');
  assert.equal(issues.get('ABC-1').state, 'In Review');
  assert.deepEqual(commands, ['État In Review'], 'the command names the configured field');
});

test('#58: getState reads the configured state field', async () => {
  const { provider } = buildLocalised();
  assert.equal(await provider.getState('ABC-1'), 'In Progress');
});

test('#58: getStates reads the configured state field in bulk', async () => {
  const { provider } = buildLocalised();
  const states = await provider.getStates(['ABC-1', 'ABC-2']);
  assert.deepEqual([...states.entries()], [['ABC-1', 'In Progress'], ['ABC-2', 'In Review']]);
});

test('#58: listOpen reads the configured state field', async () => {
  const { provider } = buildLocalised();
  const r = await provider.listOpen();
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.data.map((row) => [row.id, row.state]), [['ABC-1', 'In Progress'], ['ABC-2', 'In Review']]);
});

test('#58: getIssue reads state and assignee by their configured names, and renders neither twice', async () => {
  const { provider } = buildLocalised();
  const r = await provider.getIssue('ABC-1');
  assert.ok(r.ok, r.error);
  assert.equal(r.data.state, 'In Progress');
  assert.equal(r.data.assignee, 'ayoub');
  assert.deepEqual(r.data.fields, [{ name: 'Priorité', value: 'Majeure' }], 'État and Responsable are not generic fields');
});

test('#58: the English names are the documented default, and a config without them is unchanged', async () => {
  // The default is documented, not inferred: a config that predates the key
  // means State/Assignee, and must produce the same bytes it produced before.
  assert.deepEqual(fieldNames({}), { state: 'State', assignee: 'Assignee' });
  assert.deepEqual(fieldNames(CONFIG), { state: 'State', assignee: 'Assignee' });

  const explicit = { ...CONFIG, youtrack: { ...CONFIG.youtrack, stateField: 'State', assigneeField: 'Assignee' } };
  const seen = [];
  for (const config of [CONFIG, explicit]) {
    const fake = fakeYouTrack();
    const r = createYouTrackProvider({ config, fetch: fake.fetchImpl, onWarn: () => {} });
    assert.ok(r.ok, r.error);
    const issue = await r.provider.getIssue('ABC-1');
    const moved = await r.provider.setState('ABC-1', 'review');
    const states = await r.provider.getStates(['ABC-1', 'ABC-2']);
    seen.push(JSON.stringify({ issue, moved, states: [...states] }));
  }
  assert.equal(seen[0], seen[1]);
  assert.match(seen[0], /"state":"In Review"/);
});

test('#58: a localised instance read through the English default is the bug, and it is UNKNOWN not a crash', async () => {
  // What #58 reports: the read misses, so the baseline is UNKNOWN and every
  // spelling is exhausted. The fix is the config key, not detection.
  const { provider } = buildLocalised(CONFIG);
  assert.equal(await provider.getState('ABC-1'), UNKNOWN);
  const r = await provider.setState('ABC-1', 'review');
  assert.equal(r.ok, false);
});

test('#58: normalizeIssue takes the field names it should read', () => {
  const i = normalizeIssue(
    {
      idReadable: 'ABC-5',
      customFields: [
        { name: 'État', value: { name: 'Done' } },
        { name: 'Responsable', value: { login: 'ayoub', fullName: 'Ayoub' } },
        { name: 'State', value: { name: 'not this one' } },
      ],
    },
    { fields: { state: 'État', assignee: 'Responsable' } },
  );
  assert.equal(i.state, 'Done');
  assert.equal(i.assignee, 'ayoub');
  assert.deepEqual(i.fields, [{ name: 'State', value: 'not this one' }]);
});

test('#58: a blank field name is refused at construction, naming the key', () => {
  // Present-but-empty is not absent. `|| 'State'` would quietly read the
  // English default through a blank key and reproduce the very bug — UNKNOWN
  // before and after — with nothing naming the key that caused it (rule 2).
  for (const [key, over] of [
    ['stateField', { stateField: '' }],
    ['assigneeField', { assigneeField: '   ' }],
  ]) {
    const config = { ...CONFIG, youtrack: { ...CONFIG.youtrack, ...over } };
    const r = createYouTrackProvider({ config, fetch: async () => new Response('{}'), onWarn: () => {} });
    assert.equal(r.ok, false, `${key} blank must be refused`);
    assert.match(r.error, new RegExp(`youtrack\\.${key}`));
  }
});

test('#58: the state and assignee field names must differ', () => {
  // Two names for one field would read the assignee out of the state field
  // and render a rendered state as a person, with no warning anywhere.
  const config = { ...CONFIG, youtrack: { ...CONFIG.youtrack, stateField: 'Statut', assigneeField: 'statut' } };
  const r = createYouTrackProvider({ config, fetch: async () => new Response('{}'), onWarn: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /youtrack\.stateField/);
  assert.match(r.error, /youtrack\.assigneeField/);
});
