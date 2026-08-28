/**
 * The GitHub adapter against the provider contract, plus what the contract
 * cannot express.
 *
 * Entirely offline: the adapter takes its command runner as an argument, so
 * this hands it a fake `gh` that records the argv it was called with and
 * returns canned stdout. Asserting on the exact argv is the point — it is the
 * only way to catch a shell-quoting or flag mistake without a network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGitHubProvider, normalizeIssue } from '../lib/github.mjs';
import { UNKNOWN } from '../lib/sync.mjs';
import { runContractSuite } from './provider.contract.mjs';

const CONFIG = {
  provider: 'github',
  project: 'acme',
  states: {
    // The first rung is what an issue with NO ladder label is. GitHub installs
    // must declare it, or every untouched issue reads as in-progress.
    ladder: ['Backlog', 'In Progress', 'In Review', 'Done'],
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
  },
  github: {
    repo: 'acme/api',
    labels: {
      'In Progress': 'status: in progress',
      'In Review': 'status: review',
      Done: 'status: done',
    },
  },
};

/** A fake `gh` holding real state, so a write is visible to the next read. */
function fakeGh({ fail = false, labels = ['status: in progress', 'status: review', 'status: done'] } = {}) {
  const issues = new Map([
    [1, { number: 1, title: 'First', body: 'A body', state: 'OPEN', stateReason: null, labels: [{ name: 'status: in progress' }], assignees: [{ login: 'ayoub' }], author: { login: 'ayoub' }, createdAt: '2025-01-01T00:00:00Z', comments: [{ author: { login: 'x' }, body: 'hi', createdAt: '2025-01-02T00:00:00Z' }], url: 'https://github.com/acme/api/issues/1' }],
    [2, { number: 2, title: 'Second', body: '', state: 'OPEN', stateReason: null, labels: [{ name: 'status: review' }], assignees: [], author: { login: 'b' }, createdAt: '2025-01-01T00:00:00Z', comments: [], url: 'https://github.com/acme/api/issues/2' }],
  ]);

  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const fail0 = { ok: false, code: 1, stdout: '', stderr: 'gh exploded' };
    const out = (s) => ({ ok: true, code: 0, stdout: typeof s === 'string' ? s : JSON.stringify(s), stderr: '' });

    if (args[0] === '--version') return out('gh version 2.40.0 (2024-01-01)');
    if (args[0] === 'auth') return out('Logged in');
    if (fail) return fail0;

    if (args[0] === 'api' && args[1] === 'user') return out('ayoub');
    if (args[0] === 'repo' && args[1] === 'view') {
      return out({ nameWithOwner: 'acme/api', name: 'api', url: 'https://github.com/acme/api', viewerPermission: 'WRITE' });
    }
    if (args[0] === 'label' && args[1] === 'list') return out(labels.map((name) => ({ name })));

    if (args[0] === 'issue') {
      const n = Number(args[2]);
      if (args[1] === 'view') {
        const i = issues.get(n);
        return i ? out(i) : { ok: false, code: 1, stdout: '', stderr: 'not found' };
      }
      if (args[1] === 'list') return out([...issues.values()]);
      if (args[1] === 'edit') {
        const i = issues.get(n);
        if (!i) return { ok: false, code: 1, stdout: '', stderr: 'not found' };
        const add = [];
        const remove = [];
        for (let k = 3; k < args.length; k += 1) {
          if (args[k] === '--add-label') add.push(args[k + 1]);
          if (args[k] === '--remove-label') remove.push(args[k + 1]);
        }
        i.labels = i.labels.filter((l) => !remove.includes(l.name)).concat(add.map((name) => ({ name })));
        return out('');
      }
      if (args[1] === 'close') {
        const i = issues.get(n);
        if (i) { i.state = 'CLOSED'; i.stateReason = 'COMPLETED'; }
        return out('');
      }
      if (args[1] === 'reopen') {
        const i = issues.get(n);
        if (i) { i.state = 'OPEN'; i.stateReason = null; }
        return out('');
      }
      if (args[1] === 'comment') return out('');
      if (args[1] === 'create') {
        issues.set(9, { number: 9, title: args[args.indexOf('--title') + 1], body: opts.input ?? '', state: 'OPEN', stateReason: null, labels: [], assignees: [], author: { login: 'ayoub' }, createdAt: '2025-01-03T00:00:00Z', comments: [], url: 'https://github.com/acme/api/issues/9' });
        return out('Creating issue in acme/api\n\nhttps://github.com/acme/api/issues/9');
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: `unhandled: gh ${args.join(' ')}` };
  };

  return { run, calls, issues };
}

const build = (opts = {}) => {
  const warnings = [];
  const { run, calls, issues } = fakeGh(opts);
  const r = createGitHubProvider({ config: opts.config ?? CONFIG, run, onWarn: (m) => warnings.push(m) });
  assert.ok(r.ok, r.error);
  return { provider: r.provider, warnings, calls, issues };
};

let lastWarnings = [];
runContractSuite('github', {
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
  issueId: '#1',
  otherIssueId: '#2',
  startState: 'In Progress',
  doneState: 'Done',
  warnings: () => lastWarnings,
});

// --- configuration is required, not inferred (rule 2) -------------------------

test('a missing label mapping is refused at construction', () => {
  const r = createGitHubProvider({
    config: { ...CONFIG, github: { repo: 'acme/api', labels: { 'In Progress': 'wip' } } },
    run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /In Review, Done/, 'the error names exactly what is missing');
  assert.match(r.error, /first ladder rung/, 'and explains why the first rung needs none');
});

test('a multi-repo project must say which repo holds the issues', () => {
  // '#12' means a different issue in every repository. Rather than guess, refuse.
  const r = createGitHubProvider({
    config: { ...CONFIG, repos: [{ path: 'a' }, { path: 'b' }] },
    run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /issuesRepo/);
});

test('no repository configured at all is refused', () => {
  const r = createGitHubProvider({ config: { ...CONFIG, github: {} }, run: async () => ({}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no GitHub repository configured/);
});

// --- the exact commands -------------------------------------------------------

test('reads go out as argument arrays, never a shell string', async () => {
  const { provider, calls } = build();
  await provider.getIssue('#1');

  const view = calls.find((c) => c.args[1] === 'view');
  assert.equal(view.cmd, 'gh');
  assert.deepEqual(view.args, [
    'issue', 'view', '1', '-R', 'acme/api',
    '--json', 'number,title,body,state,stateReason,url,labels,assignees,author,createdAt,comments',
  ]);
});

test('getStates is one call for the whole batch', async () => {
  const { provider, calls } = build();
  await provider.getStates(['#1', '#2']);
  const lists = calls.filter((c) => c.args[1] === 'list');
  assert.equal(lists.length, 1, 'a per-issue loop would be a process spawn each');
  assert.ok(lists[0].args.includes('--state') && lists[0].args.includes('all'));
});

test('a long comment goes via stdin, not argv', async () => {
  const { provider, calls } = build();
  const body = 'x'.repeat(200_000);
  await provider.comment('#1', body);

  const c = calls.find((x) => x.args[1] === 'comment');
  assert.ok(c.args.includes('--body-file') && c.args.includes('-'));
  assert.equal(c.input, body);
  assert.ok(!c.args.includes(body), 'the body must not be an argument — ARG_MAX');
});

test('a title containing shell metacharacters is passed through intact', async () => {
  const { provider, calls } = build();
  const nasty = 'fix $(rm -rf /) "quoted" `backtick`';
  await provider.create({ summary: nasty, description: 'body' });

  const c = calls.find((x) => x.args[1] === 'create');
  assert.equal(c.args[c.args.indexOf('--title') + 1], nasty, 'verbatim, because argv is not a shell');
});

// --- the label ladder ---------------------------------------------------------

test('setState adds the target label and removes the siblings', async () => {
  const { provider, calls } = build();
  await provider.setState('#1', 'review');

  const edit = calls.find((c) => c.args[1] === 'edit');
  assert.ok(edit.args.includes('--add-label'));
  assert.equal(edit.args[edit.args.indexOf('--add-label') + 1], 'status: review');
  assert.ok(edit.args.includes('status: in progress'), 'the previous rung is removed');
  assert.ok(edit.args.includes('status: done'));
});

test('done also closes the issue, and reports the read-back', async () => {
  const { provider, calls } = build();
  const r = await provider.setState('#1', 'done');
  assert.ok(r.ok, r.error);
  assert.equal(r.state, 'Done');
  assert.ok(calls.some((c) => c.args[1] === 'close' && c.args.includes('completed')));
});

test('a rung other than done reopens, so a wrongly-closed issue comes back', async () => {
  const { provider } = build();
  await provider.setState('#1', 'done');
  const r = await provider.setState('#1', 'start');
  assert.ok(r.ok, r.error);
  assert.equal(r.state, 'In Progress');
});

test('closed as NOT_PLANNED is off-ladder, not done', async () => {
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'NOT_PLANNED';
  // Declined work must not be reported as shipped. Off the ladder means the
  // reconciler leaves it alone, which is the correct outcome.
  assert.equal(await provider.getState('#1'), 'not planned');
});

test('closed beats a stale label', async () => {
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: in progress' }];
  assert.equal(await provider.getState('#1'), 'Done');
});

test('an open issue with no ladder label is the first rung', async () => {
  const { provider, issues } = build();
  issues.get(1).labels = [];
  assert.equal(await provider.getState('#1'), 'Backlog');
});

test('the highest label wins when stale ones linger', async () => {
  const { provider, issues } = build();
  issues.get(1).labels = [{ name: 'status: in progress' }, { name: 'status: review' }];
  assert.equal(await provider.getState('#1'), 'In Review');
});

// --- state vs. its representation ---------------------------------------------
//
// The strand this closes: `Closes #12` in a PR body makes GitHub close the
// issue at merge, before anything relabels it. The state reads Done and the
// `in review` label stays on it forever, because `ahead` is the correct answer
// and there was nowhere to say "right state, wrong label".

test('a closed issue carrying a stale rung label is drift', async () => {
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: review' }];

  const why = (await provider.checkRepresentation(['#1'])).get('#1');
  assert.match(why, /status: review/, 'the reason names the label actually on the issue');
  assert.match(why, /Done/, 'and the state it contradicts');
});

test('an issue whose label agrees with its state is not drift', async () => {
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: done' }];
  assert.equal((await provider.checkRepresentation(['#1'])).get('#1'), null);
});

test('a closed issue with no ladder label is left alone, never backfilled', async () => {
  // Imported and bot-filed issues never entered the ladder. Labelling one
  // `done` because it happens to be closed would invent history it never had.
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'bug' }];
  assert.equal((await provider.checkRepresentation(['#1'])).get('#1'), null);
});

test('closed as NOT_PLANNED is off-ladder, so its label is not repaired either', async () => {
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'NOT_PLANNED';
  issues.get(1).labels = [{ name: 'status: review' }];
  assert.equal(
    (await provider.checkRepresentation(['#1'])).get('#1'),
    null,
    'declined work was parked deliberately — the reconciler keeps its hands off it',
  );
});

test('an open issue carrying two rung labels is drift', async () => {
  const { provider, issues } = build();
  issues.get(1).labels = [{ name: 'status: in progress' }, { name: 'status: review' }];
  const why = (await provider.checkRepresentation(['#1'])).get('#1');
  assert.match(why, /status: in progress/);
  assert.match(why, /In Review/, 'the higher label is the state; the lower one is the stale half');
  assert.ok(
    !why.includes('"status: review"'),
    'the reason names only the labels that disagree — the correct one is not part of the problem',
  );
});

test('checkRepresentation is one call for the whole batch', async () => {
  const { provider, calls } = build();
  await provider.checkRepresentation(['#1', '#2']);
  assert.equal(calls.filter((c) => c.args[1] === 'list').length, 1);
});

test('repairRepresentation relabels without opening or closing anything', async () => {
  const { provider, calls, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: review' }];

  const r = await provider.repairRepresentation('#1');
  assert.ok(r.ok, r.error);
  assert.equal(r.repaired, true);
  assert.equal(r.state, 'Done');
  assert.deepEqual(
    issues.get(1).labels.map((l) => l.name),
    ['status: done'],
  );
  assert.equal(issues.get(1).state, 'CLOSED', 'the issue itself must not move');
  assert.ok(
    !calls.some((c) => c.args[1] === 'close' || c.args[1] === 'reopen'),
    'a repair is not a transition — it must never open or close an issue',
  );
});

test('a repair only names labels the issue actually carries', async () => {
  // `gh` fails the whole edit on a label the repository does not have, and the
  // repair has just read the issue, so it has no reason to guess at siblings.
  const { provider, calls, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: review' }];

  await provider.repairRepresentation('#1');
  const edit = calls.find((c) => c.args[1] === 'edit');
  const removed = edit.args.filter((a, i) => edit.args[i - 1] === '--remove-label');
  assert.deepEqual(removed, ['status: review']);
});

test('repairing an issue whose labels already agree changes nothing', async () => {
  const { provider, calls, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: done' }];

  const r = await provider.repairRepresentation('#1');
  assert.ok(r.ok, r.error);
  assert.equal(r.repaired, false);
  assert.ok(!calls.some((c) => c.args[1] === 'edit'), 'no drift means no write');
});

test('a repair reads back, and a repeat finds nothing left to do', async () => {
  const { provider, issues } = build();
  issues.get(1).state = 'CLOSED';
  issues.get(1).stateReason = 'COMPLETED';
  issues.get(1).labels = [{ name: 'status: in progress' }, { name: 'status: review' }];

  const first = await provider.repairRepresentation('#1');
  const second = await provider.repairRepresentation('#1');
  assert.equal(first.repaired, true);
  assert.equal(second.repaired, false, 'rule 3: applying it twice converges');
  assert.equal((await provider.checkRepresentation(['#1'])).get('#1'), null);
});

test('a label missing from the repo fails loudly with the fix', async () => {
  // Creating a label in someone's repo is a visible side effect; it needs
  // consent rather than happening as a side effect of a state change.
  const { provider } = build({ labels: ['status: in progress'] });
  const r = await provider.setState('#1', 'review');
  assert.equal(r.ok, false);
  assert.match(r.error, /gh label create "status: review"/);
});

// --- create -------------------------------------------------------------------

test('create parses the issue number out of gh output despite a preamble', async () => {
  const { provider } = build();
  const r = await provider.create({ summary: 'New thing', description: 'body' });
  assert.ok(r.ok, r.error);
  assert.equal(r.id, '#9');
});

test('create warns rather than failing when a type has no label', async () => {
  const { provider } = build();
  const r = await provider.create({ summary: 'T', description: 'B', type: 'Bug' });
  assert.ok(r.ok);
  assert.match(r.warnings.join(' '), /no GitHub label mapped for type "Bug"/);
});

test('priorities are declared unsupported rather than silently dropped', () => {
  const { provider } = build();
  assert.equal(provider.capabilities.priorities, false);
  assert.equal(provider.capabilities.rawCommand, false);
});

// --- the version gate ---------------------------------------------------------

test('an old gh is refused, because stateReason would be missing', async () => {
  const run = async (cmd, args) =>
    args[0] === '--version'
      ? { ok: true, code: 0, stdout: 'gh version 2.20.0 (2023-01-01)', stderr: '' }
      : { ok: true, code: 0, stdout: '{}', stderr: '' };
  const { provider } = { provider: createGitHubProvider({ config: CONFIG, run }).provider };

  const r = await provider.resolveProject();
  assert.equal(r.ok, false);
  assert.match(r.error, /too old/);
  // Without stateReason every closed issue reads as done, which would mark
  // declined work as shipped.
  assert.match(r.error, /not planned/);
});

test('a missing gh names the install page', async () => {
  const run = async () => ({ ok: false, code: 127, stdout: '', stderr: 'not found' });
  const { provider } = createGitHubProvider({ config: CONFIG, run });
  const r = await provider.resolveProject();
  assert.equal(r.ok, false);
  assert.match(r.error, /cli\.github\.com/);
});

// --- normalisation ------------------------------------------------------------

test('normalizeIssue renders GitHub shapes into the shared form', () => {
  const i = normalizeIssue(
    {
      number: 7,
      title: 'T',
      body: 'B',
      state: 'OPEN',
      labels: [{ name: 'bug' }, { name: 'area: api' }],
      assignees: [{ login: 'ayoub' }, { login: 'other' }],
      author: { login: 'someone' },
      comments: [{ author: { login: 'x' }, body: 'hi', createdAt: '2025-01-02T03:04:05Z' }],
      url: 'https://github.com/acme/api/issues/7',
    },
    { repo: 'acme/api', stateOf: () => 'Backlog' },
  );

  assert.equal(i.id, '#7');
  assert.equal(i.assignee, 'ayoub');
  assert.equal(i.state, 'Backlog');
  assert.deepEqual(
    i.fields.map((f) => f.name),
    ['Assignees', 'Author', 'Labels'],
    'sorted, so output is stable run to run',
  );
  assert.equal(i.fields.find((f) => f.name === 'Labels').value, 'area: api, bug');
  assert.equal(i.comments[0].at, '2025-01-02T03:04:05Z');
  assert.deepEqual(i.meta.labels, ['area: api', 'bug']);
});

test('an unparseable id is refused rather than guessed at', async () => {
  const { provider } = build();
  const r = await provider.getIssue('not-an-id');
  assert.equal(r.ok, false);
  assert.match(r.error, /#123/);
  assert.equal(await provider.getState('not-an-id'), UNKNOWN);
});
