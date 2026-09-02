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
import { addPairs, addVerdicts, describeVerdicts, shortlistPairs, validatePair, validateVerdict } from '../lib/reorg.mjs';

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
