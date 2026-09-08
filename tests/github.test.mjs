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
function fakeGh({ fail = false, linkFails = false, labels = ['status: in progress', 'status: review', 'status: done'], templates = null } = {}) {
  const issues = new Map([
    [1, { number: 1, title: 'First', body: 'A body', state: 'OPEN', stateReason: null, labels: [{ name: 'status: in progress' }], assignees: [{ login: 'ayoub' }], author: { login: 'ayoub' }, createdAt: '2025-01-01T00:00:00Z', comments: [{ author: { login: 'x' }, body: 'hi', createdAt: '2025-01-02T00:00:00Z' }], url: 'https://github.com/acme/api/issues/1' }],
    [2, { number: 2, title: 'Second', body: '', state: 'OPEN', stateReason: null, labels: [{ name: 'status: review' }], assignees: [], author: { login: 'b' }, createdAt: '2025-01-01T00:00:00Z', comments: [], url: 'https://github.com/acme/api/issues/2' }],
  ]);

  // Sub-issue links, parent number -> child numbers, and the node ids the
  // mutation needs. Node ids are opaque on the real API, so any stable string
  // will do here; what matters is that the adapter asks for them by number and
  // passes them back unchanged.
  const subIssues = new Map();
  const nodeId = (n) => `I_${n}`;
  let nextNumber = 9;

  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const fail0 = { ok: false, code: 1, stdout: '', stderr: 'gh exploded' };
    const out = (s) => ({ ok: true, code: 0, stdout: typeof s === 'string' ? s : JSON.stringify(s), stderr: '' });

    if (args[0] === '--version') return out('gh version 2.40.0 (2024-01-01)');
    if (args[0] === 'auth') return out('Logged in');
    if (fail) return fail0;

    if (args[0] === 'api' && args[1] === 'user') return out('ayoub');

    // The contents API, as `templates()` drives it: a directory listing, then
    // one call per file answering base64. A repository without the directory
    // is a 404 on the listing, which is what the real one says.
    if (args[0] === 'api' && String(args[1]).startsWith('repos/acme/api/contents/.github/ISSUE_TEMPLATE')) {
      const rest = String(args[1]).slice('repos/acme/api/contents/.github/ISSUE_TEMPLATE'.length).replace(/^\//, '');
      if (!templates) return { ok: false, code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
      if (!rest) return out(Object.keys(templates).map((name) => ({ name, path: `.github/ISSUE_TEMPLATE/${name}`, type: 'file' })));
      if (!(rest in templates)) return { ok: false, code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
      return out({ name: rest, encoding: 'base64', content: Buffer.from(templates[rest]).toString('base64') });
    }

    // The batched read. Answers by exact number, and — like the real API —
    // reports a number that does not exist as an `errors` entry alongside the
    // issues that do, with `gh` exiting non-zero for the whole response.
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find((a) => String(a).startsWith('query=')) ?? '';
      const arg = (name) => args.find((a) => String(a).startsWith(`${name}=`))?.slice(name.length + 1);

      // The sub-issue mutation: node ids in, a link recorded.
      if (query.includes('addSubIssue')) {
        if (linkFails) return { ok: false, code: 1, stdout: '', stderr: 'gh: sub-issues are not enabled' };
        const parent = Number(String(arg('parentId')).replace(/^I_/, ''));
        const child = Number(String(arg('childId')).replace(/^I_/, ''));
        if (!issues.has(parent) || !issues.has(child)) return { ok: false, code: 1, stdout: '', stderr: 'not found' };
        subIssues.set(parent, [...(subIssues.get(parent) ?? []), child]);
        return out({ data: { addSubIssue: { issue: { number: parent } } } });
      }

      // The sub-issue listing, by number.
      if (query.includes('subIssues')) {
        const n = Number(arg('number'));
        const i = issues.get(n);
        if (!i) return { ok: false, code: 1, stdout: JSON.stringify({ data: { repository: { issue: null } } }), stderr: 'not found' };
        // Newest first, deliberately: the adapter is what must sort.
        const nodes = [...(subIssues.get(n) ?? [])].reverse().map((c) => {
          const ci = issues.get(c);
          return { number: ci.number, title: ci.title, url: ci.url, body: ci.body };
        });
        return out({ data: { repository: { issue: { subIssues: { nodes } } } } });
      }

      const asked = [...String(query).matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      const repository = {};
      const errors = [];
      for (const n of asked) {
        const i = issues.get(n);
        // Verified against the real API: a missing number comes back as an
        // explicit null alias plus a NOT_FOUND, not as an absent key.
        if (!i) { repository[`i${n}`] = null; errors.push({ type: 'NOT_FOUND', path: ['repository', `i${n}`] }); continue; }
        repository[`i${n}`] = {
          id: nodeId(n),
          number: i.number,
          state: i.state,
          stateReason: i.stateReason,
          labels: { nodes: i.labels.map((l) => ({ name: l.name })) },
        };
      }
      const body = JSON.stringify(errors.length ? { data: { repository }, errors } : { data: { repository } });
      return errors.length
        ? { ok: false, code: 1, stdout: body, stderr: 'gh: Could not resolve to an Issue' }
        : out(body);
    }
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
      // Newest first, capped at --limit: what `gh issue list` actually does.
      // Nothing calls this any more, and that is the point — the cap is why it
      // could not be the batched read.
      if (args[1] === 'list') {
        const limit = Number(args[args.indexOf('--limit') + 1] || 30);
        return out([...issues.values()].sort((a, b) => b.number - a.number).slice(0, limit));
      }
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
        const number = nextNumber++;
        const created = [];
        for (let k = 0; k < args.length; k += 1) if (args[k] === '--label') created.push({ name: args[k + 1] });
        issues.set(number, { number, title: args[args.indexOf('--title') + 1], body: opts.input ?? '', state: 'OPEN', stateReason: null, labels: created, assignees: [], author: { login: 'ayoub' }, createdAt: '2025-01-03T00:00:00Z', comments: [], url: `https://github.com/acme/api/issues/${number}` });
        return out(`Creating issue in acme/api\n\nhttps://github.com/acme/api/issues/${number}`);
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: `unhandled: gh ${args.join(' ')}` };
  };

  return { run, calls, issues, subIssues };
}

const build = (opts = {}) => {
  const warnings = [];
  const { run, calls, issues, subIssues } = fakeGh(opts);
  const r = createGitHubProvider({ config: opts.config ?? CONFIG, run, onWarn: (m) => warnings.push(m) });
  assert.ok(r.ok, r.error);
  return { provider: r.provider, warnings, calls, issues, subIssues };
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

const graphqlCalls = (calls) => calls.filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql');

test('getStates is one call for the whole batch', async () => {
  const { provider, calls } = build();
  await provider.getStates(['#1', '#2']);
  const reads = graphqlCalls(calls);
  assert.equal(reads.length, 1, 'a per-issue loop would be a process spawn each');
  const query = reads[0].args.find((a) => String(a).startsWith('query='));
  assert.match(query, /issue\(number: 1\)/);
  assert.match(query, /issue\(number: 2\)/, 'both numbers in the one query');
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
  assert.equal(graphqlCalls(calls).length, 1);
});

// The batched read used to be `gh issue list --limit N`, which answers with the
// N most recently *created* issues rather than the N asked about. On any
// repository with more issues than the window, an old one fell out of the
// answer, `getStates` reported UNKNOWN and the reconciler skipped it in silence
// — the same class of stranded ticket this whole path exists to repair, and
// worst in exactly the case that needs it: hunting a label stranded long ago.

test('an issue far older than any recency window is still answered', async () => {
  const { provider, calls, issues } = build();
  for (let n = 3; n <= 400; n += 1) {
    issues.set(n, { number: n, state: 'OPEN', stateReason: null, labels: [] });
  }

  assert.equal((await provider.getStates(['#1'])).get('#1'), 'In Progress');
  assert.equal(
    calls.filter((c) => c.args[1] === 'list').length,
    0,
    'a windowed list is not a read of the numbers asked about',
  );
});

test('a number that does not exist does not blank the rest of the batch', async () => {
  // GitHub answers a missing alias with a NOT_FOUND in `errors`, and `gh` exits
  // non-zero for the whole response. Throwing the body away with it would let
  // one deleted issue hide forty-nine live ones.
  const { provider } = build();
  const states = await provider.getStates(['#1', '#404']);
  assert.equal(states.get('#1'), 'In Progress');
  assert.equal(states.get('#404'), UNKNOWN, 'unread, not defaulted');
});

test('a batch larger than one query is still answered in full', async () => {
  const { provider, calls, issues } = build();
  const ids = [];
  for (let n = 1; n <= 120; n += 1) {
    if (!issues.has(n)) issues.set(n, { number: n, state: 'OPEN', stateReason: null, labels: [] });
    ids.push(`#${n}`);
  }

  const states = await provider.getStates(ids);
  assert.equal(states.size, 120);
  assert.ok(![...states.values()].includes(UNKNOWN), 'every id asked about got a real answer');
  assert.equal(graphqlCalls(calls).length, 3, '120 issues is three queries, not 120 spawns');
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

test('create passes template labels after the type label, one --label each', async () => {
  const config = { ...CONFIG, github: { ...CONFIG.github, labels: { ...CONFIG.github.labels, type: { Bug: 'kind: bug' } } } };
  const { provider, calls, issues } = build({ config, labels: ['status: in progress', 'status: review', 'status: done', 'kind: bug', 'needs-triage', 'area: export'] });
  const r = await provider.create({ summary: 'T', description: 'B', type: 'Bug', labels: ['needs-triage', 'area: export'] });
  assert.ok(r.ok, r.error);
  const c = calls.find((x) => x.args[1] === 'create');
  const labels = c.args.filter((_, i) => c.args[i - 1] === '--label');
  assert.deepEqual(labels, ['kind: bug', 'needs-triage', 'area: export']);
  assert.deepEqual(issues.get(9).labels.map((l) => l.name), ['kind: bug', 'needs-triage', 'area: export']);
});

test('a template label the repository does not have is dropped with a warning, and the issue is still filed', async () => {
  // The issue existing matters more than its labels — the same rule the type
  // label already follows. `gh issue create` fails outright on an unknown
  // label, which would turn a stale `labels:` line in a template into a
  // repository that cannot file issues.
  const { provider, calls, issues } = build({ labels: ['status: in progress', 'status: review', 'status: done', 'needs-triage'] });
  const r = await provider.create({ summary: 'T', description: 'B', labels: ['needs-triage', 'nope'] });
  assert.ok(r.ok, r.error);
  assert.equal(r.id, '#9');
  const c = calls.find((x) => x.args[1] === 'create');
  assert.deepEqual(c.args.filter((_, i) => c.args[i - 1] === '--label'), ['needs-triage']);
  assert.deepEqual(issues.get(9).labels.map((l) => l.name), ['needs-triage']);
  assert.match(r.warnings.join(' '), /"nope"/);
  assert.match(r.warnings.join(' '), /created without it/);
});

test('create without labels sends no --label at all', async () => {
  const { provider, calls } = build();
  await provider.create({ summary: 'T', description: 'B' });
  const c = calls.find((x) => x.args[1] === 'create');
  assert.ok(!c.args.includes('--label'));
});

test('a failed create surfaces what gh said', async () => {
  const run = async (cmd, args) => {
    if (args[0] === '--version') return { ok: true, code: 0, stdout: 'gh version 2.40.0 (2024-01-01)', stderr: '' };
    if (args[0] === 'auth') return { ok: true, code: 0, stdout: '', stderr: '' };
    return { ok: false, code: 1, stdout: '', stderr: "could not add label: 'nope' not found" };
  };
  const r = createGitHubProvider({ config: CONFIG, run });
  const c = await r.provider.create({ summary: 'T', description: 'B', labels: ['nope'] });
  assert.equal(c.ok, false);
  assert.match(c.error, /'nope' not found/, 'stderr from a write is never swallowed');
});

// --- templates ----------------------------------------------------------------

test('issueTemplates is declared', () => {
  const { provider } = build();
  assert.equal(provider.capabilities.issueTemplates, true);
});

test('templates() answers an empty list for a repository without the directory', async () => {
  const { provider } = build();
  const r = await provider.templates();
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.data, []);
});

test('templates() lists the directory and decodes each file, in name order', async () => {
  const { provider, calls } = build({ templates: { 'zeta.md': '## Z\n', 'alpha.yml': 'name: A\nbody: []\n', 'config.yml': 'blank_issues_enabled: false\n', 'README.txt': 'no' } });
  const r = await provider.templates();
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.data, [
    { filename: 'alpha.yml', text: 'name: A\nbody: []\n' },
    { filename: 'config.yml', text: 'blank_issues_enabled: false\n' },
    { filename: 'zeta.md', text: '## Z\n' },
  ], 'raw text, sorted; what is and is not a template is lib/issuetemplate.mjs\'s call');
  const fetched = calls.filter((c) => c.args[0] === 'api' && /ISSUE_TEMPLATE\//.test(c.args[1])).map((c) => c.args[1]);
  assert.equal(fetched.length, 3, 'one fetch per template-shaped file, none for README.txt');
});

test('a failing transport makes templates() report rather than answer empty', async () => {
  const { provider } = build({ fail: true });
  const r = await provider.templates();
  assert.equal(r.ok, false, 'an unreachable tracker is not a repository without templates');
  assert.match(r.error, /exploded/);
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

// --- sub-issues (#103) -----------------------------------------------------------

test('createChild files through the same argv as create, then links by node id', async () => {
  const { provider, calls, subIssues } = build();
  const r = await provider.createChild({ parent: '#1', summary: 'A unit', description: 'body' });
  assert.ok(r.ok, r.error);
  assert.equal(r.id, '#9');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(subIssues.get(1), [9]);

  const mutation = calls.find((c) => c.args.some((a) => String(a).includes('addSubIssue')));
  assert.ok(mutation, 'the link goes through the GraphQL mutation');
  assert.ok(mutation.args.includes('parentId=I_1'), 'the parent node id, read by number');
  assert.ok(mutation.args.includes('childId=I_9'), 'the child node id, read by number');
  // No REST database-id round trip: one batched read answers both node ids.
  assert.ok(!calls.some((c) => c.args[0] === 'api' && /issues\/\d+$/.test(c.args[1] ?? '')));
});

test('a link that fails leaves the new issue with a warning naming the parent, not an error', async () => {
  const { provider } = build({ linkFails: true });
  const r = await provider.createChild({ parent: '#1', summary: 'A unit', description: '' });
  assert.ok(r.ok, r.error);
  assert.equal(r.id, '#9');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /#9/);
  assert.match(r.warnings[0], /#1/);
  assert.match(r.warnings[0], /by hand/);
});

test('children sorts by number and carries the body build parses', async () => {
  const { provider } = build();
  await provider.createChild({ parent: '#1', summary: 'Second', description: 'Depends on: #9' });
  await provider.createChild({ parent: '#1', summary: 'First', description: '' });
  const r = await provider.children('#1');
  assert.ok(r.ok, r.error);
  assert.deepEqual(
    r.data.map((c) => [c.id, c.title, c.body]),
    [['#9', 'Second', 'Depends on: #9'], ['#10', 'First', '']],
  );
  assert.equal(r.data[0].url, 'https://github.com/acme/api/issues/9');
});

test('children of an unknown number reports rather than answering an empty list', async () => {
  const { provider } = build();
  const r = await provider.children('#404');
  assert.equal(r.ok, false);
  assert.match(r.error, /#404/);
});
