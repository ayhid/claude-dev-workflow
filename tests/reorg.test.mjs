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

import { emptyLedger, mergeSources } from '../lib/ingest.mjs';
import { addVerdicts, describeVerdicts, validateVerdict } from '../lib/reorg.mjs';

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
  const result = addVerdicts(ledger, [
    { path: 'a.md', classification: 'keep', justification: 'current' },
    { path: 'b.md', classification: 'bogus', justification: 'x' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.ledger, undefined, 'a refused batch returns no ledger, mirroring addClaims/addQuestions');
  assert.equal(ledger.verdicts, undefined, 'the input ledger itself is never mutated');
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
  assert.equal(readLedger(repo).verdicts, undefined);
});
