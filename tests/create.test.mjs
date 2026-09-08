/**
 * `dev create`'s handling of fields the backend cannot store.
 *
 * Rule 2 says a guess is worse than an error because the wrong guesses are
 * silent. Dropping a field the user explicitly asked for is the same failure
 * wearing a different hat, and it shipped: `priority` warned, `type` did not,
 * so `create "…" "…" Bug` against GitHub discarded the type without a word.
 *
 * These assert on capabilities rather than provider names, which is the point —
 * a third backend is covered the moment it declares what it supports.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DUP_STOPWORDS,
  dupKeywords,
  findDuplicates,
  parseArgs,
  renderCandidates,
  unsupportedFieldWarnings,
} from '../scripts/cmd/create.mjs';

/** A provider stub that declares only what these tests turn on. */
const provider = (name, capabilities) => ({ name, capabilities });

const github = provider('github', { types: false, priorities: false });
const youtrack = provider('youtrack', { types: true, priorities: true });

// --- the regression ----------------------------------------------------------

test('an explicit type is reported when the backend has none', () => {
  const w = unsupportedFieldWarnings(github, { type: 'Bug', typeWasGiven: true });
  assert.equal(w.length, 1);
  assert.match(w[0], /github has no issue types/);
  assert.match(w[0], /"Bug"/, 'the ignored value must appear, or the warning is not actionable');
});

test('the defaulted type is not reported', () => {
  // `run` defaults the type to `Bug`. Warning on that would fire on every
  // create against GitHub, which is how a warning becomes noise.
  assert.deepEqual(unsupportedFieldWarnings(github, { type: 'Bug', typeWasGiven: false }), []);
});

test('type and priority are symmetric', () => {
  const both = unsupportedFieldWarnings(github, {
    type: 'Bug',
    typeWasGiven: true,
    priority: 'Critical',
  });
  assert.equal(both.length, 2, 'both unsupported fields are reported, not just one');
  assert.ok(both.some((w) => /issue types/.test(w)));
  assert.ok(both.some((w) => /priorities/.test(w)));
});

// --- the supported case ------------------------------------------------------

test('a backend that supports both fields warns about neither', () => {
  const w = unsupportedFieldWarnings(youtrack, {
    type: 'Bug',
    typeWasGiven: true,
    priority: 'Critical',
  });
  assert.deepEqual(w, []);
});

test('an empty priority is not a request', () => {
  // `run` defaults priority to '', which means "unspecified", not "Priority ''".
  assert.deepEqual(unsupportedFieldWarnings(github, { priority: '' }), []);
});

test('nothing requested warns about nothing', () => {
  assert.deepEqual(unsupportedFieldWarnings(github, {}), []);
});

// --- capabilities, not names -------------------------------------------------

test('the decision follows capabilities, not the provider name', () => {
  // Same name, opposite capabilities: a name check would return the same
  // answer for both, which is the coupling the adapter layer exists to prevent.
  const capable = provider('github', { types: true, priorities: true });
  assert.deepEqual(unsupportedFieldWarnings(capable, { type: 'Bug', typeWasGiven: true }), []);
  assert.equal(
    unsupportedFieldWarnings(github, { type: 'Bug', typeWasGiven: true }).length,
    1,
  );
});

test('the warning names the provider it came from', () => {
  const other = provider('linear', { types: false, priorities: false });
  const w = unsupportedFieldWarnings(other, { priority: 'P1' });
  assert.match(w[0], /^linear /, 'a warning that does not say which backend refused is a puzzle');
});

// --- the keywords a summary becomes (#47) -------------------------------------
//
// `create` scans for duplicates itself now, so the keywords are derived from
// the summary rather than typed by a caller. The derivation is pure and
// exported so these can pin it down without a provider.

test('dupKeywords lowercases, drops short words and stopwords, keeps order', () => {
  assert.deepEqual(
    dupKeywords('Create: nothing runs the dup-check, so one defect was filed three times'),
    ['create', 'nothing', 'runs', 'dup-check', 'defect', 'filed'],
    'a hyphenated token survives whole — `dup-check` is one word, not two',
  );
});

test('dupKeywords strips GitHub search operators rather than sending them', () => {
  // A leading `-` negates a term and `:` introduces a qualifier — both would
  // turn a title fragment into a different query than the words in it.
  assert.deepEqual(dupKeywords('-metrics label:bug worktree'), ['metrics', 'labelbug', 'worktree']);
});

test('dupKeywords dedupes in first-seen order', () => {
  assert.deepEqual(dupKeywords('worktree removed before worktree close recorded'), [
    'worktree',
    'removed',
    'close',
    'recorded',
  ]);
});

test('dupKeywords caps at max, six by default', () => {
  const kws = dupKeywords('alpha bravo charlie delta echo foxtrot golf hotel');
  assert.equal(kws.length, 6);
  assert.deepEqual(dupKeywords('alpha bravo charlie delta', { max: 2 }), ['alpha', 'bravo']);
});

test('dupKeywords falls back to the raw summary when nothing survives', () => {
  // A summary of stopwords and short tokens must still produce a query, or
  // the scan silently searches for nothing and matches nothing.
  assert.deepEqual(dupKeywords('it is on'), ['it is on']);
  assert.deepEqual(dupKeywords('   '), []);
});

test('DUP_STOPWORDS is what dupKeywords drops', () => {
  assert.ok(DUP_STOPWORDS.has('the'));
  assert.ok(DUP_STOPWORDS.has('when'));
  assert.deepEqual(dupKeywords('the when'), ['the when']);
});

// --- one matcher, one renderer --------------------------------------------------

test('renderCandidates prints id and title per line, tab-separated', () => {
  const out = renderCandidates([
    { id: '#12', title: 'Half a thing' },
    { id: '#41', title: 'nobody has started this' },
  ]);
  assert.equal(out, '#12\tHalf a thing\n#41\tnobody has started this\n');
});

test('renderCandidates says so when nothing matched', () => {
  assert.equal(renderCandidates([]), 'no open issues matched\n');
});

test('findDuplicates refuses to guess on a backend that cannot search', async () => {
  let searched = false;
  const p = {
    name: 'linear',
    capabilities: { freeTextSearch: false },
    async search() {
      searched = true;
      return { ok: true, data: [] };
    },
  };
  const r = await findDuplicates(p, 'anything');
  assert.equal(r.ok, false);
  assert.match(r.error, /linear cannot search/);
  assert.equal(searched, false, 'a backend without search must not be asked');
});

test('findDuplicates hands the keywords to the provider as one query string', async () => {
  const seen = [];
  const p = {
    name: 'github',
    capabilities: { freeTextSearch: true },
    async search(q) {
      seen.push(q);
      return { ok: true, data: [{ id: '#12', title: 'Half a thing' }] };
    },
  };
  const r = await findDuplicates(p, 'half thing');
  assert.ok(r.ok);
  assert.deepEqual(seen, ['half thing']);
  assert.deepEqual(r.data, [{ id: '#12', title: 'Half a thing' }]);
});

// --- `--` ends the flags ---------------------------------------------------------

test('parseArgs treats everything after -- as positional, flags before it still apply', () => {
  const { opts, rest } = parseArgs(['--allow-duplicate', '--', '--dup-check', '-x']);
  assert.equal(opts.allowDuplicate, true);
  assert.equal(opts.dupCheck, undefined, 'a --dup-check after -- is text, not a flag');
  assert.deepEqual(rest, ['--dup-check', '-x']);
});

test('parseArgs refuses an unknown flag and says how to pass dash-led text', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag --bogus.*after `--`/);
});
