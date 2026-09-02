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
  describeReorg,
  describeVerdicts,
  mappingGate,
  resolveInconsistency,
  shortlistPairs,
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
