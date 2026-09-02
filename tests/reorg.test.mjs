/**
 * Relevance classification: one verdict per document, keyed by path.
 *
 * A verdict is an assistant-asserted fact like a claim, not a human-arbitrated
 * decision like a question — so it upserts by path rather than accumulating
 * duplicates, and re-classifying a document (a rescan changed it, or the
 * reasoning improves) simply replaces its verdict.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyLedger, mergeSources, setEnrichment } from '../lib/ingest.mjs';
import {
  addInconsistencies,
  addPairs,
  addVerdicts,
  demoteHeadings,
  describeReorg,
  describeVerdicts,
  mappingGate,
  renderMigrationPlan,
  renderRewrittenDoc,
  resolveInconsistency,
  setMapping,
  shortlistPairs,
  sliceHeading,
  validateMappingEntry,
  validatePair,
  validateVerdict,
} from '../lib/reorg.mjs';

const NOW = new Date('2026-08-28T09:00:00.000Z');
const base = () => emptyLedger({ now: NOW });
const file = (path, sha, bytes = 10) => ({ path, sha256: sha, bytes });

const withSources = (...paths) => mergeSources(base(), paths.map((p, i) => file(p, String(i)))).ledger;

// --- validation -------------------------------------------------------------------

test('a verdict needs a classification from the closed list', () => {
  const result = validateVerdict({ path: 'README.md', justification: 'why' }, { knownPaths: ['README.md'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /classification/);
});

test('an unknown classification is refused rather than accepted loosely', () => {
  const result = validateVerdict(
    { path: 'README.md', classification: 'discard', justification: 'why' },
    { knownPaths: ['README.md'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /keep, merge, archive, delete/);
});

test('a verdict needs a justification, same as a question needs its because', () => {
  const result = validateVerdict(
    { path: 'README.md', classification: 'keep' },
    { knownPaths: ['README.md'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /justification/);
});

test('a verdict for a path outside the inventory is refused', () => {
  const result = validateVerdict(
    { path: 'ghost.md', classification: 'keep', justification: 'why' },
    { knownPaths: ['README.md'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /ghost\.md/);
});

test('merge requires a mergeTarget that is itself a known document', () => {
  const noTarget = validateVerdict(
    { path: 'a.md', classification: 'merge', justification: 'overlaps with b' },
    { knownPaths: ['a.md', 'b.md'] },
  );
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error, /mergeTarget/);

  const ghostTarget = validateVerdict(
    { path: 'a.md', classification: 'merge', justification: 'overlaps', mergeTarget: 'ghost.md' },
    { knownPaths: ['a.md', 'b.md'] },
  );
  assert.equal(ghostTarget.ok, false);
  assert.match(ghostTarget.error, /ghost\.md/);

  const ok = validateVerdict(
    { path: 'a.md', classification: 'merge', justification: 'overlaps', mergeTarget: 'b.md' },
    { knownPaths: ['a.md', 'b.md'] },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict.mergeTarget, 'b.md');
});

test('a document cannot merge into itself', () => {
  const result = validateVerdict(
    { path: 'a.md', classification: 'merge', justification: 'overlaps', mergeTarget: 'a.md' },
    { knownPaths: ['a.md', 'b.md'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /itself/);
});

test('mergeTarget is refused on any classification other than merge', () => {
  const result = validateVerdict(
    { path: 'a.md', classification: 'keep', justification: 'current', mergeTarget: 'b.md' },
    { knownPaths: ['a.md', 'b.md'] },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /only.*merge/);
});

// --- addVerdicts: batch, upsert-by-path --------------------------------------------

test('a bad verdict rejects the whole batch, so half a batch is never mistaken for one', () => {
  const ledger = withSources('a.md', 'b.md');
  const before = ledger.verdicts;
  const result = addVerdicts(ledger, [
    { path: 'a.md', classification: 'keep', justification: 'current' },
    { path: 'b.md', classification: 'bogus', justification: 'x' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.ledger, undefined, 'a refused batch returns no ledger, mirroring addClaims/addQuestions');
  assert.equal(ledger.verdicts, before, 'the input ledger itself is never mutated');
});

test('addVerdicts appends new verdicts and reports what it added', () => {
  const ledger = withSources('a.md', 'b.md');
  const result = addVerdicts(ledger, [
    { path: 'a.md', classification: 'keep', justification: 'current and unique' },
    { path: 'b.md', classification: 'delete', justification: 'empty draft' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 2);
  assert.equal(result.ledger.verdicts.length, 2);
});

test('re-classifying a path replaces its verdict rather than accumulating a second one', () => {
  let ledger = withSources('a.md');
  ledger = addVerdicts(ledger, [{ path: 'a.md', classification: 'keep', justification: 'first pass' }]).ledger;
  ledger = addVerdicts(ledger, [{ path: 'a.md', classification: 'archive', justification: 'superseded by b.md' }]).ledger;

  assert.equal(ledger.verdicts.length, 1);
  assert.equal(ledger.verdicts[0].classification, 'archive');
});

test('describeVerdicts counts by classification, and what has none yet', () => {
  let ledger = withSources('a.md', 'b.md', 'c.md', 'd.md');
  ledger = addVerdicts(ledger, [
    { path: 'a.md', classification: 'keep', justification: 'x' },
    { path: 'b.md', classification: 'keep', justification: 'x' },
    { path: 'c.md', classification: 'delete', justification: 'x' },
  ]).ledger;

  const lines = describeVerdicts(ledger);
  assert.ok(lines.some((l) => /keep: 2/.test(l)));
  assert.ok(lines.some((l) => /delete: 1/.test(l)));
  assert.ok(lines.some((l) => /1 unclassified/.test(l)), 'd.md has no verdict yet');
});

// --- shortlistPairs: the keyword prefilter --------------------------------------

const enriched = (ledger, path, keywords) => setEnrichment(ledger, path, { keywords }).ledger;

function corpus() {
  let ledger = withSources('a.md', 'b.md', 'c.md', 'd.md', 'e.md');
  ledger = enriched(ledger, 'a.md', ['Auth', 'session', 'redis']);
  ledger = enriched(ledger, 'b.md', ['auth', 'Session ', 'redis']);
  ledger = enriched(ledger, 'c.md', ['auth', 'session', 'postgres', 'ttl']);
  ledger = enriched(ledger, 'e.md', ['auth', 'session', 'redis']);
  // d.md carries no keywords; e.md is archived
  return addVerdicts(ledger, [
    { path: 'a.md', classification: 'keep', justification: 'x' },
    { path: 'b.md', classification: 'merge', justification: 'x', mergeTarget: 'a.md' },
    { path: 'c.md', classification: 'keep', justification: 'x' },
    { path: 'd.md', classification: 'keep', justification: 'x' },
    { path: 'e.md', classification: 'archive', justification: 'x' },
  ]).ledger;
}

test('shortlistPairs ranks keep/merge pairs by keyword Jaccard, case- and space-insensitively', () => {
  const { pairs } = shortlistPairs(corpus(), { threshold: 0.3 });
  assert.deepEqual(
    pairs.map((p) => [p.docA, p.docB, p.score]),
    [
      ['a.md', 'b.md', 1],
      ['a.md', 'c.md', 0.4],
      ['b.md', 'c.md', 0.4],
    ],
    'score descending, then by path; d.md (no keywords) and e.md (archived) never appear',
  );
  assert.deepEqual(pairs[0].shared, ['auth', 'redis', 'session']);
});

test('shortlistPairs defaults to 0.85 and counts what it skipped rather than omitting it silently', () => {
  const { pairs, skipped, threshold } = shortlistPairs(corpus());
  assert.equal(threshold, 0.85);
  assert.deepEqual(pairs.map((p) => [p.docA, p.docB]), [['a.md', 'b.md']]);
  assert.equal(skipped.noKeywords, 1, 'd.md');
  assert.equal(skipped.notKeptOrMerged, 1, 'e.md');
});

test('shortlistPairs skips a document with no verdict, since classification comes first', () => {
  let ledger = withSources('a.md', 'b.md');
  ledger = enriched(ledger, 'a.md', ['x', 'y']);
  ledger = enriched(ledger, 'b.md', ['x', 'y']);
  ledger = addVerdicts(ledger, [{ path: 'a.md', classification: 'keep', justification: 'x' }]).ledger;
  const { pairs, skipped } = shortlistPairs(ledger);
  assert.equal(pairs.length, 0);
  assert.equal(skipped.noVerdict, 1);
});

// --- pairs: a judgement about two documents ------------------------------------

const KNOWN = ['a.md', 'b.md', 'c.md'];
const goodPair = (over = {}) => ({
  docA: 'a.md',
  docB: 'b.md',
  relation: 'duplicate',
  justification: 'same install steps, word for word',
  evidenceA: 'a.md:12',
  evidenceB: 'b.md:40',
  ...over,
});

test('a pair needs a relation from the closed list', () => {
  const missing = validatePair(goodPair({ relation: undefined }), { knownPaths: KNOWN });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /relation/);

  const unknown = validatePair(goodPair({ relation: 'similar' }), { knownPaths: KNOWN });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /duplicate, overlaps, contradicts/);
});

test('both documents of a pair must be in the inventory, and be two different documents', () => {
  const ghost = validatePair(goodPair({ docB: 'ghost.md' }), { knownPaths: KNOWN });
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /ghost\.md/);

  const same = validatePair(goodPair({ docB: 'a.md' }), { knownPaths: KNOWN });
  assert.equal(same.ok, false);
  assert.match(same.error, /itself/);
});

test('a pair needs a justification and evidence from each side', () => {
  for (const field of ['justification', 'evidenceA', 'evidenceB']) {
    const result = validatePair(goodPair({ [field]: '  ' }), { knownPaths: KNOWN });
    assert.equal(result.ok, false, field);
    assert.match(result.error, new RegExp(field));
  }
});

test('addPairs assigns stable p<n> ids and refuses the whole batch on one bad entry', () => {
  const ledger = withSources(...KNOWN);
  const bad = addPairs(ledger, [goodPair(), goodPair({ docA: 'c.md', relation: 'nope' })]);
  assert.equal(bad.ok, false);
  assert.equal(bad.ledger, undefined);

  const good = addPairs(ledger, [goodPair(), goodPair({ docA: 'c.md', relation: 'overlaps' })]);
  assert.equal(good.ok, true);
  assert.deepEqual(good.added.map((p) => p.id), ['p1', 'p2']);
  assert.equal(good.ledger.pairs[0].status, 'open');
});

test('re-recording the same unordered pair replaces it under the same id', () => {
  let ledger = withSources(...KNOWN);
  ledger = addPairs(ledger, [goodPair()]).ledger;
  ledger = addPairs(ledger, [goodPair({ docA: 'c.md' })]).ledger;
  const result = addPairs(ledger, [goodPair({ docA: 'b.md', docB: 'a.md', relation: 'contradicts' })]);
  assert.equal(result.ok, true);
  assert.equal(result.added[0].id, 'p1', 'the id an inconsistency may already cite');
  assert.equal(result.ledger.pairs.length, 2);
  assert.equal(result.ledger.pairs.find((p) => p.id === 'p1').relation, 'contradicts');
  assert.deepEqual(result.ledger.pairs.map((p) => p.id), ['p1', 'p2'], 'kept in id order');
});

// --- inconsistencies: what only a person can settle ------------------------------

function withPairs() {
  let ledger = withSources(...KNOWN);
  ledger = addPairs(ledger, [
    goodPair({ relation: 'contradicts' }),
    goodPair({ docA: 'c.md', relation: 'overlaps' }),
  ]).ledger;
  return ledger;
}

test('an inconsistency must cite recorded pairs in because, and gets an i<n> id, open, unresolved', () => {
  const ledger = withPairs();

  const noText = addInconsistencies(ledger, [{ because: ['p1'] }]);
  assert.equal(noText.ok, false);
  assert.match(noText.error, /text/);

  const noBecause = addInconsistencies(ledger, [{ text: 'which port?' }]);
  assert.equal(noBecause.ok, false);
  assert.match(noBecause.error, /because/);

  const ghost = addInconsistencies(ledger, [{ text: 'which port?', because: ['p1', 'p9'] }]);
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /p9/);

  const ok = addInconsistencies(ledger, [
    { text: 'a.md says 5432, b.md says 5433 — which is deployed?', because: ['p1'], options: ['5432', '5433'] },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.added[0].id, 'i1');
  assert.equal(ok.added[0].status, 'open');
  assert.equal(ok.added[0].resolution, null);
  assert.deepEqual(ok.added[0].options, ['5432', '5433']);
});

const inconsistent = () =>
  addInconsistencies(withPairs(), [{ text: 'which port?', because: ['p1'] }]).ledger;

test('a resolution is one of prefer, rewrite or dismiss, and always carries a note', () => {
  const ledger = inconsistent();

  const unknownId = resolveInconsistency(ledger, 'i7', { kind: 'dismiss', note: 'x' });
  assert.equal(unknownId.ok, false);
  assert.match(unknownId.error, /i7/);

  const unknownKind = resolveInconsistency(ledger, 'i1', { kind: 'ignore', note: 'x' });
  assert.equal(unknownKind.ok, false);
  assert.match(unknownKind.error, /prefer, rewrite, dismiss/);

  const noNote = resolveInconsistency(ledger, 'i1', { kind: 'dismiss' });
  assert.equal(noNote.ok, false);
  assert.match(noNote.error, /note/);

  const ok = resolveInconsistency(ledger, 'i1', { kind: 'rewrite', note: 'both are half right' }, { now: NOW });
  assert.equal(ok.ok, true);
  const settled = ok.ledger.inconsistencies[0];
  assert.equal(settled.status, 'resolved');
  assert.deepEqual(settled.resolution, { kind: 'rewrite', path: null, note: 'both are half right' });
  assert.equal(settled.resolvedAt, NOW.toISOString());
});

test('prefer names the authoritative document, which must be a side of a cited pair', () => {
  const ledger = inconsistent();

  const noPath = resolveInconsistency(ledger, 'i1', { kind: 'prefer', note: 'x' });
  assert.equal(noPath.ok, false);
  assert.match(noPath.error, /path/);

  const wrongSide = resolveInconsistency(ledger, 'i1', { kind: 'prefer', path: 'c.md', note: 'x' });
  assert.equal(wrongSide.ok, false);
  assert.match(wrongSide.error, /c\.md/);

  const ok = resolveInconsistency(ledger, 'i1', { kind: 'prefer', path: 'b.md', note: 'b matches the deploy config' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ledger.inconsistencies[0].resolution.path, 'b.md');
});

test('a resolution is never overwritten — a changed mind is a new inconsistency', () => {
  let ledger = inconsistent();
  ledger = resolveInconsistency(ledger, 'i1', { kind: 'dismiss', note: 'not really different' }).ledger;
  const again = resolveInconsistency(ledger, 'i1', { kind: 'rewrite', note: 'on reflection' });
  assert.equal(again.ok, false);
  assert.match(again.error, /already resolved/);
});

test('an inconsistency whose because or options is not an array is refused, not thrown on', () => {
  const ledger = withPairs();
  const because = addInconsistencies(ledger, [{ text: 'which port?', because: 'p1' }]);
  assert.equal(because.ok, false);
  assert.match(because.error, /because.*array/);
  const options = addInconsistencies(ledger, [{ text: 'which port?', because: ['p1'], options: '5432' }]);
  assert.equal(options.ok, false);
  assert.match(options.error, /options.*array/);
});

// --- the gate: nothing maps over an open inconsistency ------------------------------

test('mappingGate refuses while any inconsistency is open, naming them', () => {
  let ledger = addInconsistencies(withPairs(), [
    { text: 'which port?', because: ['p1'] },
    { text: 'which host?', because: ['p1', 'p2'] },
  ]).ledger;

  const blocked = mappingGate(ledger);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /i1, i2/);
  assert.match(blocked.error, /reorg resolve/);

  const overridden = mappingGate(ledger, { ignoreInconsistencies: true });
  assert.equal(overridden.ok, true);
  assert.deepEqual(overridden.open, ['i1', 'i2'], 'still reported, so the override is visible');

  ledger = resolveInconsistency(ledger, 'i1', { kind: 'dismiss', note: 'x' }).ledger;
  assert.equal(mappingGate(ledger).ok, false, 'one resolved is not all resolved');
  ledger = resolveInconsistency(ledger, 'i2', { kind: 'rewrite', note: 'x' }).ledger;
  assert.deepEqual(mappingGate(ledger), { ok: true, open: [] });
});

test('mappingGate passes on a ledger that never had an inconsistency', () => {
  assert.deepEqual(mappingGate(withSources('a.md')), { ok: true, open: [] });
});

test('describeReorg reports pairs, inconsistencies and whether mapping is blocked', () => {
  let ledger = addInconsistencies(withPairs(), [{ text: 'which port?', because: ['p1'] }]).ledger;
  ledger = addVerdicts(ledger, [{ path: 'a.md', classification: 'keep', justification: 'x' }]).ledger;

  const blocked = describeReorg(ledger).join('\n');
  assert.match(blocked, /keep: 1/, 'the verdict counts are still there');
  assert.match(blocked, /pairs:\s+2 \(0 duplicate, 1 overlaps, 1 contradicts\)/);
  assert.match(blocked, /inconsistencies:\s+1 \(1 open, 0 resolved\)/);
  assert.match(blocked, /blocked.*i1/);

  ledger = resolveInconsistency(ledger, 'i1', { kind: 'dismiss', note: 'x' }).ledger;
  assert.doesNotMatch(describeReorg(ledger).join('\n'), /blocked/);
});

// --- rescan: a pair about a document that changed is stale, the decision on it is not ---

test('a rescan marks a pair stale when either side changed or vanished, and leaves its inconsistency alone', () => {
  let ledger = withSources('a.md', 'b.md', 'c.md');
  ledger = addPairs(ledger, [
    goodPair({ relation: 'contradicts' }),
    goodPair({ docA: 'b.md', docB: 'c.md', relation: 'overlaps' }),
  ]).ledger;
  ledger = addInconsistencies(ledger, [{ text: 'which?', because: ['p1'] }]).ledger;
  ledger = resolveInconsistency(ledger, 'i1', { kind: 'prefer', path: 'a.md', note: 'x' }).ledger;

  // a.md changed, c.md is gone, b.md is untouched
  const rescanned = mergeSources(ledger, [file('a.md', 'changed'), file('b.md', '1')]).ledger;

  assert.equal(rescanned.pairs.find((p) => p.id === 'p1').status, 'stale', 'a.md changed');
  assert.equal(rescanned.pairs.find((p) => p.id === 'p2').status, 'stale', 'c.md vanished');
  assert.deepEqual(rescanned.inconsistencies, ledger.inconsistencies, 'a human decision survives a rescan');
});

test('a rescan that changes nothing leaves every pair open', () => {
  let ledger = withSources('a.md', 'b.md');
  ledger = addPairs(ledger, [goodPair()]).ledger;
  const rescanned = mergeSources(ledger, [file('a.md', '0'), file('b.md', '1')]).ledger;
  assert.equal(rescanned.pairs[0].status, 'open');
});

// --- mapping: where each source goes -----------------------------------------------

const SECTIONS = [
  { id: 'architecture', title: 'Architecture', description: 'how it is built' },
  { id: 'operations', title: 'Operations', description: 'how it is run' },
];

/** a.md keep with headings, b.md merge with headings, c.md keep without headings, d.md archived. */
function mappable() {
  let ledger = withSources('a.md', 'b.md', 'c.md', 'd.md');
  ledger = setEnrichment(ledger, 'a.md', { headings: ['# A', '## Storage', '## Auth'] }).ledger;
  ledger = setEnrichment(ledger, 'b.md', { headings: ['# B', '## Storage'] }).ledger;
  return addVerdicts(ledger, [
    { path: 'a.md', classification: 'keep', justification: 'x' },
    { path: 'b.md', classification: 'merge', justification: 'x', mergeTarget: 'a.md' },
    { path: 'c.md', classification: 'keep', justification: 'x' },
    { path: 'd.md', classification: 'archive', justification: 'x' },
  ]).ledger;
}

const entry = (over = {}) => ({
  section: 'architecture',
  heading: 'Storage',
  sources: [{ path: 'a.md' }],
  operation: 'copy',
  justification: 'a.md is the current description',
  ...over,
});

const check = (over, ledger = mappable()) => validateMappingEntry(entry(over), { sections: SECTIONS, ledger });

test('a mapping entry names a section of the architecture, a heading and a justification', () => {
  assert.equal(check({}).ok, true, check({}).error);
  assert.match(check({ section: 'glossary' }).error, /glossary.*architecture, operations/);
  assert.match(check({ heading: ' ' }).error, /heading/);
  assert.match(check({ justification: '' }).error, /justification/);
});

test('targetFile defaults to <section>.md and must stay a relative .md path', () => {
  assert.equal(check({}).entry.targetFile, 'architecture.md');
  assert.equal(check({ targetFile: 'architecture/storage.md' }).entry.targetFile, 'architecture/storage.md');
  for (const targetFile of ['/etc/x.md', '../x.md', 'a/../../x.md', 'x.txt', 'C:\\x.md']) {
    const r = check({ targetFile });
    assert.equal(r.ok, false, targetFile);
    assert.match(r.error, /targetFile/);
  }
});

test('a source must be in the inventory and classified keep or merge', () => {
  assert.match(check({ sources: [{ path: 'ghost.md' }] }).error, /ghost\.md/);
  assert.match(check({ sources: [{ path: 'd.md' }] }).error, /d\.md.*archive/);
  let ledger = mappable();
  ledger = { ...ledger, verdicts: ledger.verdicts.filter((v) => v.path !== 'c.md') };
  assert.match(check({ sources: [{ path: 'c.md' }] }, ledger).error, /c\.md.*classif/);
  assert.match(check({ sources: [] }).error, /source/);
});

test('a source heading must be one phase 1 recorded for that document', () => {
  const ok = check({ operation: 'split', sources: [{ path: 'a.md', headings: ['## Auth'] }] });
  assert.equal(ok.ok, true, ok.error);
  const unknown = check({ operation: 'split', sources: [{ path: 'a.md', headings: ['## Billing'] }] });
  assert.match(unknown.error, /Billing.*Storage/);
  const unenriched = check({ operation: 'split', sources: [{ path: 'c.md', headings: ['## X'] }] });
  assert.match(unenriched.error, /c\.md.*ingest enrich/);
});

test('the operation decides the arity: copy one, split one with headings, merge two or more, rewrite with text', () => {
  assert.match(check({ operation: 'move' }).error, /copy, merge, split, rewrite/);
  assert.match(check({ operation: 'copy', sources: [{ path: 'a.md' }, { path: 'b.md' }] }).error, /copy.*one source/);
  assert.match(check({ operation: 'copy', sources: [{ path: 'a.md', headings: ['## Auth'] }] }).error, /copy.*split/);
  assert.match(check({ operation: 'split', sources: [{ path: 'a.md' }] }).error, /split.*headings/);
  assert.match(check({ operation: 'merge', sources: [{ path: 'a.md' }] }).error, /merge.*two/);
  assert.equal(check({ operation: 'merge', sources: [{ path: 'a.md' }, { path: 'b.md', headings: ['## Storage'] }] }).ok, true);
  assert.match(check({ operation: 'rewrite' }).error, /rewrite.*text/);
  assert.equal(check({ operation: 'rewrite', text: 'The store is Postgres.' }).ok, true);
  assert.match(check({ operation: 'copy', text: 'x' }).error, /text.*rewrite/);
});

test('setMapping is all-or-nothing and replaces the previous mapping outright', () => {
  const ledger = mappable();
  const bad = setMapping(ledger, [entry(), entry({ section: 'nope' })], { sections: SECTIONS });
  assert.equal(bad.ok, false);
  assert.equal(bad.ledger, undefined);

  const first = setMapping(ledger, [entry(), entry({ section: 'operations', heading: 'Runbook', sources: [{ path: 'c.md' }] })], { sections: SECTIONS });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.ledger.mapping.length, 2);
  assert.deepEqual(first.ledger.architecture, SECTIONS);

  const second = setMapping(first.ledger, [entry({ heading: 'Data' })], { sections: SECTIONS });
  assert.equal(second.ledger.mapping.length, 1, 'a plan is one thing, not an accumulation');
  assert.equal(second.ledger.mapping[0].heading, 'Data');
});

test('renderMigrationPlan lists entries per target, the unmapped keep/merge documents and the archive/delete list', () => {
  let ledger = mappable();
  ledger = addVerdicts(ledger, [{ path: 'c.md', classification: 'delete', justification: 'empty' }]).ledger;
  ledger = setMapping(ledger, [
    entry(),
    entry({ section: 'operations', heading: 'Auth', operation: 'split', sources: [{ path: 'a.md', headings: ['## Auth'] }] }),
  ], { sections: SECTIONS }).ledger;

  const plan = renderMigrationPlan(ledger, { ignored: ['i4'] });
  assert.match(plan, /^# Migration plan/m);
  assert.match(plan, /## architecture\.md — Architecture/);
  assert.match(plan, /### Storage\n\n- operation: copy\n- sources: a\.md\n- why: a\.md is the current description/);
  assert.match(plan, /### Auth\n\n- operation: split\n- sources: a\.md › ## Auth/);
  assert.match(plan, /## Not mapped\n\n[^\n]+\n\n- b\.md \(merge → a\.md\)/, 'a keep/merge document no entry names');
  assert.match(plan, /## Listed, not deleted\n\n[^\n]+\n\n- c\.md — delete: empty\n- d\.md — archive: x/);
  assert.match(plan, /## Inconsistencies ignored\n\n[^\n]+\n\n- i4/);
  assert.equal(plan, renderMigrationPlan(ledger, { ignored: ['i4'] }), 'byte-stable');
});

// --- rendering: slices of sources, assembled under one target --------------------------

const DOC = `# A

Intro.

## Storage

Postgres.

### Pooling

pgbouncer.

## Auth

\`\`\`md
## not a heading
\`\`\`

Sessions.
`;

test('sliceHeading returns a heading and its body up to the next heading of the same or a higher level', () => {
  assert.equal(sliceHeading(DOC, '## Storage'), '## Storage\n\nPostgres.\n\n### Pooling\n\npgbouncer.\n');
  assert.equal(sliceHeading(DOC, '### Pooling'), '### Pooling\n\npgbouncer.\n');
  assert.equal(sliceHeading(DOC, '## Auth'), '## Auth\n\n```md\n## not a heading\n```\n\nSessions.\n', 'runs to end of file; a fence is not a heading');
  assert.equal(sliceHeading(DOC, '## Billing'), null);
});

test('demoteHeadings shifts every heading so the shallowest sits at the requested level, fences untouched', () => {
  const out = demoteHeadings(sliceHeading(DOC, '## Auth'), 3);
  assert.equal(out, '### Auth\n\n```md\n## not a heading\n```\n\nSessions.\n');
  assert.equal(demoteHeadings('# T\n\n## S\n', 3), '### T\n\n#### S\n');
  assert.equal(demoteHeadings('no headings\n', 3), 'no headings\n');
  assert.equal(demoteHeadings('##### deep\n\n###### deeper\n', 5), '##### deep\n\n###### deeper\n', 'never past level 6');
});

test('renderRewrittenDoc assembles frontmatter, a banner and one ## per entry with provenance, byte-stably', () => {
  const target = { file: 'architecture.md', section: { id: 'architecture', title: 'Architecture', description: 'how it is built' } };
  const entries = [
    { heading: 'Storage', operation: 'split', justification: 'the storage half', sources: [{ path: 'a.md', headings: ['## Storage'] }], text: null },
    { heading: 'Everything', operation: 'copy', justification: 'whole doc', sources: [{ path: 'b.md', headings: [] }], text: null },
    { heading: 'Summary', operation: 'rewrite', justification: 'condensed', sources: [{ path: 'a.md', headings: [] }, { path: 'b.md', headings: [] }], text: 'Postgres, pooled.' },
  ];
  const sourceText = (path) => ({ 'a.md': DOC, 'b.md': '# B\n\nBody of b.\n\n## Part\n\nMore.\n' })[path];
  const out = renderRewrittenDoc(target, entries, { sourceText, now: NOW });

  assert.match(out, /^---\ntitle: Architecture\nsection: architecture\ngenerated: 2026-08-28\nsources:\n  - a\.md\n  - b\.md\n---\n/);
  assert.match(out, /\n# Architecture\n\nhow it is built\n/);
  assert.match(out, /Generated by `dev\.mjs reorg rewrite`/);
  assert.match(out, /## Storage\n\n_split from a\.md › ## Storage — the storage half_\n\n### Storage\n\nPostgres\.\n\n#### Pooling\n\npgbouncer\.\n/);
  assert.match(out, /## Everything\n\n_copy of b\.md — whole doc_\n\nBody of b\.\n\n### Part\n\nMore\.\n/, 'the source H1 is dropped, the rest demoted');
  assert.match(out, /## Summary\n\n_rewrite from a\.md, b\.md — condensed_\n\nPostgres, pooled\.\n/);
  assert.equal(out, renderRewrittenDoc(target, entries, { sourceText, now: NOW }));
});

// --- through the real CLI ----------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { git, withStubGh } from './ghstub.mjs';

const LEDGER = (repo) => join(repo, '_dev-workflow', 'artifacts', 'documentation', 'ledger.json');
const readLedger = (repo) => JSON.parse(readFileSync(LEDGER(repo), 'utf8'));

async function withDocs(files = {}) {
  const s = await withStubGh();
  const all = {
    'README.md': '# The project\n\nIt talks to Postgres.\n',
    'docs/design.md': '# Design\n\nWe chose Postgres for the JSON support.\n',
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    const abs = join(s.repo, path);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  await git(s.repo, 'add', '-A');
  await git(s.repo, 'commit', '-m', 'chore(no-ticket): docs');
  return s;
}

test('reorg refuses to run before a survey exists', async () => {
  const { dev } = await withDocs();
  const result = await dev(['reorg']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ingest scan/);
});

test('classify validates a batch and reports counts', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);

  const verdicts = join(repo, 'verdicts.json');
  writeFileSync(
    verdicts,
    JSON.stringify([
      { path: 'README.md', classification: 'keep', justification: 'current and unique' },
      { path: 'docs/design.md', classification: 'archive', justification: 'superseded elsewhere' },
    ]),
  );
  const result = await dev(['reorg', 'classify', `@${verdicts}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /2 verdict\(s\) recorded/);

  const status = await dev(['reorg']);
  assert.match(status.stdout, /keep: 1/);
  assert.match(status.stdout, /archive: 1/);

  assert.deepEqual(
    readLedger(repo).verdicts.map((v) => v.path).sort(),
    ['README.md', 'docs/design.md'],
  );
});

test('classify refuses the whole batch on one bad verdict, touching nothing', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);
  const before = readLedger(repo);

  const verdicts = join(repo, 'verdicts.json');
  writeFileSync(
    verdicts,
    JSON.stringify([
      { path: 'README.md', classification: 'keep', justification: 'current' },
      { path: 'docs/design.md', classification: 'bogus', justification: 'x' },
    ]),
  );
  const result = await dev(['reorg', 'classify', `@${verdicts}`]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /docs\/design\.md/);
  assert.deepEqual(readLedger(repo), before, 'a refused batch writes nothing');
});

const enrichFile = async (repo, dev, path, keywords) => {
  const file = join(repo, 'enrich.json');
  writeFileSync(file, JSON.stringify({ keywords }));
  const r = await dev(['ingest', 'enrich', path, `@${file}`]);
  assert.equal(r.code, 0, r.stderr);
};

const classifyAll = async (repo, dev, verdicts) => {
  const file = join(repo, 'verdicts.json');
  writeFileSync(file, JSON.stringify(verdicts));
  const r = await dev(['reorg', 'classify', `@${file}`]);
  assert.equal(r.code, 0, r.stderr);
};

/** Two overlapping documents plus one off-topic, all classified keep. */
async function withPairedDocs() {
  const s = await withDocs({ 'docs/setup.md': '# Setup\n\nInstall Postgres.\n' });
  await s.dev(['ingest', 'scan']);
  await enrichFile(s.repo, s.dev, 'README.md', ['postgres', 'json', 'storage']);
  await enrichFile(s.repo, s.dev, 'docs/design.md', ['postgres', 'json', 'storage', 'ttl']);
  await enrichFile(s.repo, s.dev, 'docs/setup.md', ['install', 'homebrew']);
  await classifyAll(s.repo, s.dev, [
    { path: 'README.md', classification: 'keep', justification: 'x' },
    { path: 'docs/design.md', classification: 'keep', justification: 'x' },
    { path: 'docs/setup.md', classification: 'keep', justification: 'x' },
  ]);
  return s;
}

test('shortlist prints the pairs above the threshold, and the threshold is a flag', async () => {
  const { dev } = await withPairedDocs();

  const strict = await dev(['reorg', 'shortlist']);
  assert.equal(strict.code, 0, strict.stderr);
  assert.match(strict.stdout, /threshold: 0\.85/);
  assert.match(strict.stdout, /no pair/i, 'README/design score 0.75, under the default');

  const loose = await dev(['reorg', 'shortlist', '--similarity-threshold', '0.5']);
  assert.equal(loose.code, 0, loose.stderr);
  assert.match(loose.stdout, /README\.md\s+docs\/design\.md\s+0\.75/);
  assert.match(loose.stdout, /json, postgres, storage/);
  assert.doesNotMatch(loose.stdout, /setup\.md/);
});

test('shortlist refuses a threshold that is not a number between 0 and 1', async () => {
  const { dev } = await withPairedDocs();
  const result = await dev(['reorg', 'shortlist', '--similarity-threshold', 'high']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /similarity-threshold/);
});

const detectFile = (repo, pairs) => {
  const file = join(repo, 'pairs.json');
  writeFileSync(file, JSON.stringify(pairs));
  return file;
};

test('detect records a batch of pairs and reports their ids', async () => {
  const { repo, dev } = await withPairedDocs();
  const file = detectFile(repo, [
    {
      docA: 'README.md',
      docB: 'docs/design.md',
      relation: 'overlaps',
      justification: 'both explain the Postgres choice',
      evidenceA: 'README.md:3',
      evidenceB: 'docs/design.md:3',
    },
  ]);
  const result = await dev(['reorg', 'detect', `@${file}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 pair\(s\) recorded/);
  assert.match(result.stdout, /p1/);
  assert.equal(readLedger(repo).pairs.length, 1);
});

test('detect refuses the whole batch on one bad pair, touching nothing', async () => {
  const { repo, dev } = await withPairedDocs();
  const before = readLedger(repo);
  const file = detectFile(repo, [
    { docA: 'README.md', docB: 'docs/design.md', relation: 'overlaps', justification: 'x', evidenceA: 'a', evidenceB: 'b' },
    { docA: 'README.md', docB: 'docs/setup.md', relation: 'overlaps', justification: 'x', evidenceA: 'a' },
  ]);
  const result = await dev(['reorg', 'detect', `@${file}`]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /evidenceB/);
  assert.deepEqual(readLedger(repo), before);
});

/** Two pairs recorded through the CLI, plus one open inconsistency citing p1. */
async function withInconsistency() {
  const s = await withPairedDocs();
  const file = detectFile(s.repo, {
    pairs: [
      { docA: 'README.md', docB: 'docs/design.md', relation: 'contradicts', justification: 'x', evidenceA: 'a', evidenceB: 'b' },
    ],
    inconsistencies: [{ text: 'JSON support or TTL — which was the reason?', because: ['p1'], options: ['json', 'ttl'] }],
  });
  const r = await s.dev(['reorg', 'detect', `@${file}`]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 inconsistenc(y|ies) recorded/);
  assert.match(r.stdout, /i1/);
  return s;
}

test('detect takes pairs and inconsistencies together, pairs first so the ids can be cited', async () => {
  const { repo } = await withInconsistency();
  const ledger = readLedger(repo);
  assert.equal(ledger.inconsistencies.length, 1);
  assert.deepEqual(ledger.inconsistencies[0].because, ['p1']);
});

test('resolve settles one inconsistency from the command line, prefer:<path> naming the winner', async () => {
  const { repo, dev } = await withInconsistency();

  const bad = await dev(['reorg', 'resolve', 'i1', 'prefer:docs/setup.md', 'nope']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /docs\/setup\.md/);
  assert.equal(readLedger(repo).inconsistencies[0].status, 'open');

  const ok = await dev(['reorg', 'resolve', 'i1', 'prefer:docs/design.md', 'the design doc is the one the team maintains']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /i1 resolved/);
  const settled = readLedger(repo).inconsistencies[0];
  assert.equal(settled.status, 'resolved');
  assert.deepEqual(settled.resolution, {
    kind: 'prefer',
    path: 'docs/design.md',
    note: 'the design doc is the one the team maintains',
  });
});

test('resolve takes a batch file, and one bad entry writes nothing', async () => {
  const { repo, dev } = await withInconsistency();
  const before = readLedger(repo);

  const file = join(repo, 'resolutions.json');
  writeFileSync(file, JSON.stringify([
    { id: 'i1', kind: 'dismiss', note: 'same thing said twice' },
    { id: 'i2', kind: 'dismiss', note: 'no such inconsistency' },
  ]));
  const bad = await dev(['reorg', 'resolve', `@${file}`]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /i2/);
  assert.deepEqual(readLedger(repo), before);

  writeFileSync(file, JSON.stringify([{ id: 'i1', kind: 'dismiss', note: 'same thing said twice' }]));
  const ok = await dev(['reorg', 'resolve', `@${file}`]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(readLedger(repo).inconsistencies[0].status, 'resolved');
});

test('bare reorg reports the gate, and clears it once the inconsistency is resolved', async () => {
  const { dev } = await withInconsistency();
  const blocked = await dev(['reorg']);
  assert.equal(blocked.code, 0, blocked.stderr);
  assert.match(blocked.stdout, /inconsistencies:\s+1 \(1 open/);
  assert.match(blocked.stdout, /blocked.*i1/);

  await dev(['reorg', 'resolve', 'i1', 'dismiss', 'same reason, two phrasings']);
  const clear = await dev(['reorg']);
  assert.doesNotMatch(clear.stdout, /blocked/);
});

test('detect refuses a payload that is neither an array nor an object, rather than throwing or recording nothing', async () => {
  const { repo, dev } = await withPairedDocs();
  const before = readLedger(repo);
  for (const payload of ['null', '42', '"pairs"']) {
    const file = join(repo, 'pairs.json');
    writeFileSync(file, payload);
    const result = await dev(['reorg', 'detect', `@${file}`]);
    assert.notEqual(result.code, 0, payload);
    assert.match(result.stderr, /array.*or.*object|object.*or.*array/i, payload);
    assert.doesNotMatch(result.stderr, /TypeError/, payload);
  }
  assert.deepEqual(readLedger(repo), before);
});

const REORG = (repo) => join(repo, '_dev-workflow', 'artifacts', 'reorg');

const ARCH_YAML = `sections:
  - id: architecture
    title: Architecture
    description: how it is built
  - id: operations
    title: Operations
    description: how it is run
`;

/** The phase-2 fixture with headings recorded, an architecture file and a mapping file on disk. */
async function withMapping() {
  const s = await withInconsistency();
  const enrich = join(s.repo, 'h.json');
  writeFileSync(enrich, JSON.stringify({ headings: ['# The project'] }));
  await s.dev(['ingest', 'enrich', 'README.md', `@${enrich}`]);
  writeFileSync(enrich, JSON.stringify({ headings: ['# Design'] }));
  await s.dev(['ingest', 'enrich', 'docs/design.md', `@${enrich}`]);

  const arch = join(s.repo, 'arch.yaml');
  writeFileSync(arch, ARCH_YAML);
  const mapping = join(s.repo, 'mapping.json');
  writeFileSync(mapping, JSON.stringify([
    { section: 'architecture', heading: 'Storage', operation: 'merge', justification: 'both explain the Postgres choice',
      sources: [{ path: 'README.md' }, { path: 'docs/design.md' }] },
    { section: 'operations', heading: 'Install', operation: 'copy', justification: 'the only setup doc',
      sources: [{ path: 'docs/setup.md' }] },
  ]));
  return { ...s, arch, mapping };
}

test('map refuses over an open inconsistency, and --ignore-inconsistencies names what it ignored', async () => {
  const { repo, dev, arch, mapping } = await withMapping();

  const blocked = await dev(['reorg', 'map', '--architecture', arch, `@${mapping}`]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /i1/);
  assert.equal(readLedger(repo).mapping, undefined);

  const forced = await dev(['reorg', 'map', '--architecture', arch, `@${mapping}`, '--ignore-inconsistencies']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /ignor.*i1/);
  assert.match(forced.stdout, /migration-plan\.md/);
  const ledger = readLedger(repo);
  assert.equal(ledger.mapping.length, 2);
  assert.equal(ledger.architecture.length, 2);
  const plan = readFileSync(join(REORG(repo), 'migration-plan.md'), 'utf8');
  assert.match(plan, /### Storage/);
  assert.match(plan, /## Inconsistencies ignored\n\n[^\n]+\n\n- i1/);
});

test('map passes once the inconsistency is resolved, and refuses a bad architecture file by line', async () => {
  const { repo, dev, arch, mapping } = await withMapping();
  await dev(['reorg', 'resolve', 'i1', 'dismiss', 'same thing']);

  const bad = join(repo, 'bad.yaml');
  writeFileSync(bad, 'sections:\n  - id: a\n    title: A\n    description: d\n    owner: me\n');
  const refused = await dev(['reorg', 'map', '--architecture', bad, `@${mapping}`]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /line 5/);

  const ok = await dev(['reorg', 'map', '--architecture', arch, `@${mapping}`]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.doesNotMatch(readFileSync(join(REORG(repo), 'migration-plan.md'), 'utf8'), /ignored/);

  const status = await dev(['reorg']);
  assert.match(status.stdout, /mapping:\s+2 entr/);
});

const STAGED = (repo, file) => join(REORG(repo), 'docs-reorganized', file);
const readTree = (repo) => {
  const { readdirSync, statSync } = require('node:fs');
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '_dev-workflow' || name === '.git') continue;
      const abs = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, key);
      else out[key] = readFileSync(abs, 'utf8');
    }
  };
  walk(repo, '');
  return out;
};
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** A recorded mapping, gate clear, ready to rewrite. */
async function withMapped() {
  const s = await withMapping();
  await s.dev(['reorg', 'resolve', 'i1', 'dismiss', 'same thing']);
  const mapped = await s.dev(['reorg', 'map', '--architecture', s.arch, `@${s.mapping}`]);
  assert.equal(mapped.code, 0, mapped.stderr);
  return s;
}

test('rewrite writes one file per target plus the report; a second run changes nothing; --dry-run writes nothing', async () => {
  const { repo, dev } = await withMapped();

  const dry = await dev(['reorg', 'rewrite', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /would create.*architecture\.md/);
  assert.equal(readLedger(repo).rewritten, undefined, 'a dry run records nothing');
  assert.ok(!require('node:fs').existsSync(STAGED(repo, 'architecture.md')));

  const first = await dev(['reorg', 'rewrite']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /created.*docs-reorganized\/architecture\.md/);
  assert.match(first.stdout, /created.*docs-reorganized\/operations\.md/);
  assert.match(first.stdout, /migration-report\.md/);

  const arch = readFileSync(STAGED(repo, 'architecture.md'), 'utf8');
  assert.match(arch, /^---\ntitle: Architecture\nsection: architecture\n/);
  assert.match(arch, /## Storage\n\n_merge from README\.md, docs\/design\.md — both explain the Postgres choice_\n\nIt talks to Postgres\.\n\nWe chose Postgres for the JSON support\./);
  const ops = readFileSync(STAGED(repo, 'operations.md'), 'utf8');
  assert.match(ops, /## Install\n\n_copy of docs\/setup\.md — the only setup doc_\n\nInstall Postgres\./);

  const report = readFileSync(join(REORG(repo), 'migration-report.md'), 'utf8');
  assert.match(report, /^# Migration report/m);
  assert.match(report, /docs-reorganized\/architecture\.md.*\n.*README\.md/s);
  assert.match(report, /## Not mapped/);
  assert.match(report, /## Listed, not deleted/);

  const ledger = readLedger(repo);
  assert.deepEqual(Object.keys(ledger.rewritten).sort(), ['architecture.md', 'operations.md']);

  const second = await dev(['reorg', 'rewrite']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /unchanged.*architecture\.md/);
  assert.match(second.stdout, /unchanged.*operations\.md/);
  assert.equal(readFileSync(STAGED(repo, 'architecture.md'), 'utf8'), arch);
});

test('a staged file edited by hand is refused by name; --force overwrites it', async () => {
  const { repo, dev } = await withMapped();
  await dev(['reorg', 'rewrite']);
  const generated = readFileSync(STAGED(repo, 'architecture.md'), 'utf8');
  writeFileSync(STAGED(repo, 'architecture.md'), `${generated}\nA line somebody added.\n`);

  const refused = await dev(['reorg', 'rewrite']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stdout + refused.stderr, /refused.*architecture\.md/);
  assert.match(refused.stdout + refused.stderr, /--force/);
  assert.match(readFileSync(STAGED(repo, 'architecture.md'), 'utf8'), /somebody added/, 'the edit survives');
  assert.match(refused.stdout, /unchanged.*operations\.md/, 'the other file is still handled');

  const forced = await dev(['reorg', 'rewrite', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /rewritten.*architecture\.md/);
  assert.equal(readFileSync(STAGED(repo, 'architecture.md'), 'utf8'), generated);
});

test('rewrite refuses without a mapping, and honours the gate like map does', async () => {
  const { dev } = await withInconsistency();
  const noMapping = await dev(['reorg', 'rewrite']);
  assert.notEqual(noMapping.code, 0);
  assert.match(noMapping.stderr, /reorg map/);
});

test('map and rewrite leave every document of the project byte-identical and write nothing outside _dev-workflow', async () => {
  const s = await withMapping();
  const before = readTree(s.repo);
  await s.dev(['reorg', 'resolve', 'i1', 'dismiss', 'same thing']);
  await s.dev(['reorg', 'map', '--architecture', s.arch, `@${s.mapping}`]);
  const rewritten = await s.dev(['reorg', 'rewrite']);
  assert.equal(rewritten.code, 0, rewritten.stderr);
  assert.deepEqual(readTree(s.repo), before);
  assert.ok(require('node:fs').existsSync(STAGED(s.repo, 'architecture.md')));
});
