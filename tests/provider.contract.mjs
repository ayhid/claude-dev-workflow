/**
 * The provider contract, as an executable specification.
 *
 * Every adapter must pass this suite unchanged. It is exported as a function
 * rather than written as tests so each adapter's own test file can run it
 * against its own injected fake — `tests/youtrack.provider.test.mjs` and
 * `tests/github.test.mjs` both call `runContractSuite`.
 *
 * That is the point of the abstraction: adding a third backend should mean one
 * new adapter file and one new call to this function, with no change to the
 * core and no change here. If a new backend cannot pass one of these, the
 * disagreement is real and belongs in the design, not papered over with a
 * special case in a command.
 *
 * The four determinism rules from lib/provider.mjs are what most of these
 * assert; each test names the rule it is enforcing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UNKNOWN } from '../lib/sync.mjs';

/**
 * @param {string} label            adapter name, used in test titles
 * @param {object} h                the harness this adapter provides
 * @param {() => Promise<object>} h.make          a working provider
 * @param {() => Promise<object>} h.makeFailing   one whose transport always fails
 * @param {string} h.issueId        an id the working provider knows about
 * @param {string} h.otherIssueId   a second one
 * @param {string} h.startState     the state `start` resolves to
 * @param {string} h.doneState      the state `done` resolves to
 * @param {() => string[]} h.warnings   warnings captured via onWarn
 */
export function runContractSuite(label, h) {
  const t = (name, fn) => test(`[${label}] ${name}`, fn);

  // --- shape ------------------------------------------------------------------

  t('implements every member of the interface', async () => {
    const p = await h.make();
    for (const m of [
      'getIssue',
      'getState',
      'getStates',
      'search',
      'resolveProject',
      'whoami',
      'setState',
      'comment',
      'create',
    ]) {
      assert.equal(typeof p[m], 'function', `${m} must be implemented`);
    }
    assert.equal(typeof p.name, 'string');
    assert.ok(p.syntax?.regex instanceof RegExp, 'syntax.regex must be a RegExp');
    assert.equal(typeof p.syntax.ere, 'string', 'syntax.ere is what the bash hook needs');
    assert.equal(typeof p.syntax.sample, 'string');
    for (const c of ['types', 'priorities', 'assignee', 'freeTextSearch', 'rawCommand']) {
      assert.equal(typeof p.capabilities[c], 'boolean', `capabilities.${c} must be declared`);
    }
  });

  t('getIssue returns a fully normalized issue', async () => {
    const p = await h.make();
    const r = await p.getIssue(h.issueId);
    assert.ok(r.ok, r.error);
    const i = r.data;

    assert.equal(typeof i.id, 'string');
    assert.equal(typeof i.title, 'string');
    assert.equal(typeof i.body, 'string', 'body is a string even when empty');
    assert.equal(typeof i.state, 'string');
    assert.ok(Array.isArray(i.fields));
    assert.ok(Array.isArray(i.comments));

    // Rule 4: values are already rendered, so no caller has to know a
    // backend's value shapes to print them.
    for (const f of i.fields) {
      assert.equal(typeof f.name, 'string');
      assert.equal(typeof f.value, 'string', `field ${f.name} must arrive rendered`);
    }
    // ISO-8601 or null — never an epoch, never a locale string.
    for (const c of i.comments) {
      assert.equal(typeof c.author, 'string');
      assert.equal(typeof c.body, 'string');
      if (c.at !== null) assert.match(c.at, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  // --- rule 4: stable output --------------------------------------------------

  t('rule 4: the same issue normalizes identically twice', async () => {
    const p = await h.make();
    const a = await p.getIssue(h.issueId);
    const b = await p.getIssue(h.issueId);
    assert.deepEqual(a.data, b.data, 'same inputs must give byte-identical output');
    assert.deepEqual(
      a.data.fields.map((f) => f.name),
      [...a.data.fields.map((f) => f.name)].sort(),
      'fields must be sorted, or ordering varies run to run',
    );
  });

  // --- reads ------------------------------------------------------------------

  t('getStates agrees with getState, one issue at a time', async () => {
    const p = await h.make();
    const ids = [h.issueId, h.otherIssueId];
    const batch = await p.getStates(ids);

    assert.ok(batch instanceof Map);
    for (const id of ids) {
      assert.equal(batch.get(id), await p.getState(id), `${id} must agree between batch and single`);
    }
  });

  t('getStates reports every id it was asked about', async () => {
    const p = await h.make();
    // Including one that does not exist: absent must read as UNKNOWN, not as a
    // missing key the reconciler would silently skip.
    const ids = [h.issueId, 'NOPE-99999'];
    const batch = await p.getStates(ids);
    for (const id of ids) assert.ok(batch.has(id), `${id} missing from the batch result`);
    assert.equal(batch.get('NOPE-99999'), UNKNOWN);
  });

  t('getStates of nothing is an empty map, not an error', async () => {
    const p = await h.make();
    const batch = await p.getStates([]);
    assert.equal(batch.size, 0);
  });

  // --- rule 3: writes read back and converge ----------------------------------

  t('rule 3: setState reports the state it read back', async () => {
    const p = await h.make();
    const r = await p.setState(h.issueId, h.doneState);
    assert.ok(r.ok, r.error);
    assert.equal(r.state, await p.getState(h.issueId), 'must report what is actually there');
  });

  t('rule 3: setState applied twice converges', async () => {
    const p = await h.make();
    const first = await p.setState(h.issueId, h.doneState);
    const second = await p.setState(h.issueId, h.doneState);
    assert.ok(first.ok && second.ok);
    assert.equal(first.state, second.state, 'a repeat must be a no-op, not a double-apply');
  });

  // --- rule 2: no inference ---------------------------------------------------

  t('rule 2: an unmapped state is an error, not a guess', async () => {
    const p = await h.make();
    const r = await p.setState(h.issueId, 'Definitely Not A Configured State');
    assert.equal(r.ok, false, 'must refuse rather than invent a mapping');
    assert.match(r.error, /not|unknown|no /i, 'the error must say what is wrong');
  });

  // --- failure behaviour ------------------------------------------------------

  t('a failed read returns UNKNOWN and says why', async () => {
    const p = await h.makeFailing();
    const state = await p.getState(h.issueId);
    assert.equal(state, UNKNOWN);
    assert.ok(
      h.warnings().length > 0,
      'returning UNKNOWN silently discards the cause — the sync table then shows ? with no reason',
    );
  });

  t('a failed batch read marks every id UNKNOWN', async () => {
    const p = await h.makeFailing();
    const batch = await p.getStates([h.issueId, h.otherIssueId]);
    for (const id of [h.issueId, h.otherIssueId]) assert.equal(batch.get(id), UNKNOWN);
  });

  t('a failed write reports an error rather than throwing', async () => {
    const p = await h.makeFailing();
    const r = await p.setState(h.issueId, h.doneState);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  });

  t('a failed getIssue reports an error rather than throwing', async () => {
    const p = await h.makeFailing();
    const r = await p.getIssue(h.issueId);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  });
}
