/**
 * The documentation ledger.
 *
 * The claim — statement, source, anchor, kind — is the whole design, so most of
 * what is asserted here is what the ledger *refuses*: an observable claim with
 * no evidence, a question with no claims behind it, an answer that would
 * overwrite a decision somebody already made. A ledger that accepts those reads
 * exactly like one that was checked, which is worse than having none.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addClaims,
  addQuestions,
  answerQuestion,
  classifyPath,
  describeLedger,
  emptyLedger,
  mergeSources,
  nextUnit,
  renderMap,
  setEnrichment,
  validateClaim,
  validateEnrichment,
} from '../lib/ingest.mjs';

const NOW = new Date('2026-08-28T09:00:00.000Z');
const base = () => emptyLedger({ now: NOW });

const observable = { text: 'The commit hook is registered in settings.json', kind: 'observable', anchor: '.claude/settings.json:6', source: 'README.md', topic: 'enforcement' };
const intent = { text: 'Worktree mode is default so starting a ticket never disturbs open work', kind: 'intent', source: 'CLAUDE.md', topic: 'design' };

const withClaims = (...claims) => {
  const r = addClaims(base(), claims);
  assert.ok(r.ok, r.error);
  return r.ledger;
};

// --- what counts as a document -------------------------------------------------

test('prose is a document; code, generated files and our own output are not', () => {
  assert.equal(classifyPath('README.md'), 'doc');
  assert.equal(classifyPath('docs/configuration.md'), 'doc');
  assert.equal(classifyPath('CLAUDE.md'), 'doc');
  assert.equal(classifyPath('lib/vcs.mjs'), 'source');

  // A CHANGELOG is a true record and a useless source of claims: it says what
  // changed, never what is.
  assert.equal(classifyPath('CHANGELOG.md'), 'other');
  assert.equal(classifyPath('LICENSE'), 'other');

  // Reading our own generated map back in would compound every mistake it made.
  assert.equal(classifyPath('_dev-workflow/artifacts/documentation/map.md'), 'other');

  // `.claude/skills/dev-*` is the shipped skills again, installed. Surveying
  // both copies reads every one twice and manufactures a contradiction between
  // a file and itself — found the first time this was run against this repo.
  assert.equal(classifyPath('.claude/skills/dev-task/SKILL.md'), 'other');
});

test('an agent-skill payload is instructions for an agent, not prose about the project', () => {
  // The rule is the directory, not the `dev-` prefix it used to be. A repo that
  // vendors third-party packs tracks them, so `git ls-files` hands every file to
  // the classifier: 72% of one affected corpus (#34).
  assert.equal(classifyPath('.claude/skills/release/SKILL.md'), 'other');
  assert.equal(classifyPath('.claude/skills/some-pack/references/api.md'), 'other');
  assert.equal(classifyPath('.agents/skills/vendored/SKILL.md'), 'other');
  assert.equal(classifyPath('.gemini/skills/vendored/references/usage.md'), 'other');
  assert.equal(classifyPath('.claude/plugins/marketplace/README.md'), 'other');

  // A pack's own source is excluded for being a payload, not for its extension —
  // so the source rule must not be what happens to catch it.
  assert.equal(classifyPath('.claude/skills/some-pack/scripts/run.mjs'), 'other');

  // The exclusion is scoped to the payload directories and nothing above them.
  // `.claude/` also holds a project's own hand-written config and hooks, and
  // CLAUDE.md at the root stays the document it has always been.
  assert.equal(classifyPath('CLAUDE.md'), 'doc');
  assert.equal(classifyPath('docs/architecture.md'), 'doc');
  assert.equal(classifyPath('skills/authoring.md'), 'doc');
});

// --- the refusals ---------------------------------------------------------------

test('an observable claim with no anchor is refused, and told what to do instead', () => {
  const r = validateClaim({ text: 'The API is fast', kind: 'observable' }, { id: 'c1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no anchor/);
  assert.match(r.error, /file:line/);
  assert.match(r.error, /kind "intent"/, 'name the escape, or the rule just blocks honest work');
});

test('an intent claim needs a source, since nothing in the tree can settle it', () => {
  const r = validateClaim({ text: 'We chose Postgres for the JSON support', kind: 'intent' }, { id: 'c1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no source/);
});

test('a claim with no kind is refused rather than guessed at', () => {
  const r = validateClaim({ text: 'Something', anchor: 'a.js:1' }, { id: 'c1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /observable or intent/);
});

test('a bad claim rejects the whole batch, so half a batch is never mistaken for one', () => {
  const r = addClaims(base(), [observable, { text: 'no anchor', kind: 'observable' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /no anchor/);
});

test('a question with no claims behind it is refused', () => {
  // Otherwise the survey starts inventing questions, and an interview is not a
  // survey.
  const r = addQuestions(withClaims(observable), [{ text: 'What should we do?' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /names no claims/);

  const unknown = addQuestions(withClaims(observable), [{ text: 'Which?', because: ['c99'] }]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown claims: c99/);
});

test('an answered question is never overwritten', () => {
  let ledger = withClaims(intent);
  ledger = addQuestions(ledger, [{ text: 'Which is right?', because: ['c1'] }]).ledger;
  ledger = answerQuestion(ledger, 'q1', 'The second one', { now: NOW }).ledger;

  const again = answerQuestion(ledger, 'q1', 'Actually the first', { now: NOW });
  assert.equal(again.ok, false);
  assert.match(again.error, /already answered/);
  assert.match(again.error, /Record a new question/, 'the record of what was decided must survive');
  assert.equal(answerQuestion(ledger, 'q404', 'x').ok, false);
});

// --- ids and ordering ------------------------------------------------------------

test('ids continue across batches rather than restarting', () => {
  const first = withClaims(observable, intent);
  const second = addClaims(first, [observable]);
  assert.deepEqual(second.ledger.claims.map((c) => c.id), ['c1', 'c2', 'c3']);
});

// --- re-scanning ------------------------------------------------------------------

const file = (path, sha, bytes = 10) => ({ path, sha256: sha, bytes });

test('an unchanged document keeps its read state, so a second scan costs nothing', () => {
  let ledger = mergeSources(base(), [file('README.md', 'aaa')]).ledger;
  ledger = { ...ledger, sources: ledger.sources.map((s) => ({ ...s, state: 'read' })) };

  const again = mergeSources(ledger, [file('README.md', 'aaa')]);
  assert.equal(again.ledger.sources[0].state, 'read');
  assert.deepEqual([again.added, again.changed, again.gone], [[], [], []]);
});

test('a changed document is re-read, and its claims go stale rather than vanishing', () => {
  let ledger = mergeSources(base(), [file('README.md', 'aaa')]).ledger;
  ledger = { ...ledger, sources: ledger.sources.map((s) => ({ ...s, state: 'read' })) };
  ledger = addClaims(ledger, [observable]).ledger;

  const again = mergeSources(ledger, [file('README.md', 'bbb')], { now: NOW });
  assert.equal(again.ledger.sources[0].state, 'pending');
  assert.deepEqual(again.changed, ['README.md']);
  // Kept: somebody may have arbitrated a question about this very claim.
  assert.equal(again.ledger.claims[0].status, 'stale');
  assert.equal(again.ledger.claims.length, 1);
});

test('a changed document drops its relevance verdict rather than keeping a stale classification', () => {
  let ledger = mergeSources(base(), [file('README.md', 'aaa')]).ledger;
  ledger = { ...ledger, verdicts: [{ path: 'README.md', classification: 'keep', justification: 'current' }] };

  const again = mergeSources(ledger, [file('README.md', 'bbb')]);
  assert.deepEqual(again.ledger.verdicts, [], 'the verdict was for content that no longer exists');
});

test('an unchanged document keeps its verdict across a rescan', () => {
  let ledger = mergeSources(base(), [file('README.md', 'aaa')]).ledger;
  ledger = { ...ledger, verdicts: [{ path: 'README.md', classification: 'keep', justification: 'current' }] };

  const again = mergeSources(ledger, [file('README.md', 'aaa')]);
  assert.deepEqual(again.ledger.verdicts, ledger.verdicts);
});

test('a document that disappeared is recorded as gone, not dropped', () => {
  const ledger = mergeSources(base(), [file('gone.md', 'aaa')]).ledger;
  const again = mergeSources(ledger, []);
  assert.deepEqual(again.gone, ['gone.md']);
  assert.equal(again.ledger.sources[0].state, 'missing');
});

test('a vanished document drops its relevance verdict too — there is nothing left to classify', () => {
  let ledger = mergeSources(base(), [file('gone.md', 'aaa')]).ledger;
  ledger = { ...ledger, verdicts: [{ path: 'gone.md', classification: 'keep', justification: 'current' }] };

  const again = mergeSources(ledger, []);
  assert.deepEqual(again.ledger.verdicts, []);
});

test('sources are sorted, so the same inventory always renders the same bytes', () => {
  const a = mergeSources(base(), [file('z.md', '1'), file('a.md', '2')]).ledger;
  assert.deepEqual(a.sources.map((s) => s.path), ['a.md', 'z.md']);
});

// --- enrichment -----------------------------------------------------------------------

test('enrichment with none of the recognised fields is refused', () => {
  const result = validateEnrichment({});
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing to enrich/);
});

test('a blank summary is refused rather than stored as an empty string', () => {
  const result = validateEnrichment({ summary: '   ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /summary/);
});

test('a non-string summary is refused rather than stringified', () => {
  const result = validateEnrichment({ summary: { topic: 'db' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /summary/);
});

test('keywords must be a non-empty array of non-empty strings', () => {
  assert.equal(validateEnrichment({ keywords: [] }).ok, false);
  assert.equal(validateEnrichment({ keywords: ['', '  '] }).ok, false);
  assert.equal(validateEnrichment({ keywords: 'not-an-array' }).ok, false);
  assert.equal(validateEnrichment({ keywords: [1, 2] }).ok, false, 'a number is not silently stringified');

  const ok = validateEnrichment({ keywords: [' redis ', 'cache'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.enrichment.keywords, ['redis', 'cache']);
});

test('headings must be an array of non-empty strings', () => {
  assert.equal(validateEnrichment({ headings: [1, 2] }).ok, false);
  const ok = validateEnrichment({ headings: ['## Storage', '## Auth'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.enrichment.headings, ['## Storage', '## Auth']);
});

test('wordCount must be a non-negative integer', () => {
  assert.equal(validateEnrichment({ wordCount: -1 }).ok, false);
  assert.equal(validateEnrichment({ wordCount: 1.5 }).ok, false);
  assert.equal(validateEnrichment({ wordCount: 'many' }).ok, false);
  assert.equal(validateEnrichment({ wordCount: 0 }).ok, true);
});

test('frontmatter must be a plain object, not an array or a scalar', () => {
  assert.equal(validateEnrichment({ frontmatter: ['a'] }).ok, false);
  assert.equal(validateEnrichment({ frontmatter: 'title: x' }).ok, false);
  const ok = validateEnrichment({ frontmatter: { title: 'Storage' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.enrichment.frontmatter, { title: 'Storage' });
});

test('setEnrichment refuses a path that is not in the inventory', () => {
  const ledger = mergeSources(base(), [file('README.md', 'aaa')]).ledger;
  const result = setEnrichment(ledger, 'missing.md', { summary: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing\.md/);
});

test('setEnrichment merges fields onto the matching source, leaving others untouched', () => {
  let ledger = mergeSources(base(), [file('README.md', 'aaa'), file('docs/design.md', 'bbb')]).ledger;
  const result = setEnrichment(ledger, 'README.md', { summary: 'What the project does.', wordCount: 42 });
  assert.equal(result.ok, true);

  const readme = result.ledger.sources.find((s) => s.path === 'README.md');
  assert.equal(readme.summary, 'What the project does.');
  assert.equal(readme.wordCount, 42);

  const design = result.ledger.sources.find((s) => s.path === 'docs/design.md');
  assert.equal(design.summary, undefined);
});

test('a re-scan with an unchanged hash keeps enrichment; a changed hash drops it', () => {
  let ledger = mergeSources(base(), [file('README.md', 'aaa')]).ledger;
  ledger = setEnrichment(ledger, 'README.md', { summary: 'Stable summary.' }).ledger;

  const same = mergeSources(ledger, [file('README.md', 'aaa')]).ledger;
  assert.equal(same.sources[0].summary, 'Stable summary.');

  const changed = mergeSources(ledger, [file('README.md', 'zzz')]).ledger;
  assert.equal(changed.sources[0].summary, undefined, 'stale enrichment for a changed file is not carried over');
});

// --- one step at a time -------------------------------------------------------------

test('the next unit is a single thing, and the phases run in order', () => {
  assert.match(nextUnit(base()).what, /nothing has been inventoried/);

  let ledger = mergeSources(base(), [file('a.md', '1'), file('b.md', '2')]).ledger;
  const first = nextUnit(ledger);
  assert.equal(first.phase, 'extract');
  assert.equal(first.detail.path, 'a.md', 'one document, and the first in a stable order');
  assert.equal(first.detail.remaining, 2);

  ledger = { ...ledger, sources: ledger.sources.map((s) => ({ ...s, state: 'read' })) };
  ledger = addClaims(ledger, [intent]).ledger;
  ledger = addQuestions(ledger, [{ text: 'Which?', because: ['c1'] }]).ledger;

  // Reading is done, so arbitration is next — never both at once.
  const second = nextUnit(ledger);
  assert.equal(second.phase, 'arbitrate');
  assert.equal(second.detail.questions.length, 1);

  ledger = answerQuestion(ledger, 'q1', 'This one', { now: NOW }).ledger;
  assert.equal(nextUnit(ledger).phase, 'emit');
});

test('nextUnit exposes the full pending batch, not only the next document', () => {
  const ledger = mergeSources(base(), [file('a.md', '1'), file('b.md', '2'), file('c.md', '3')]).ledger;
  const unit = nextUnit(ledger);
  assert.equal(unit.phase, 'extract');
  assert.deepEqual(
    unit.detail.pending,
    ['a.md', 'b.md', 'c.md'],
    'every pending path, sorted — not only the one being read next',
  );
});

test('stale claims are work, and are surfaced after the reading and the answering', () => {
  let ledger = mergeSources(base(), [file('a.md', '1')]).ledger;
  ledger = { ...ledger, sources: ledger.sources.map((s) => ({ ...s, state: 'read' })) };
  ledger = addClaims(ledger, [observable]).ledger;
  ledger = { ...ledger, claims: ledger.claims.map((c) => ({ ...c, status: 'stale' })) };

  const unit = nextUnit(ledger);
  assert.equal(unit.phase, 'extract');
  assert.match(unit.what, /came from documents that have changed/);
});

test('status counts without spilling the detail', () => {
  let ledger = mergeSources(base(), [file('a.md', '1')]).ledger;
  ledger = addClaims(ledger, [observable, intent]).ledger;
  const out = describeLedger(ledger).join('\n');

  assert.match(out, /sources: +1 \(0 read, 1 pending/);
  assert.match(out, /claims: +2 \(1 observable, 1 intent/);
  assert.match(out, /next: +\[extract\]/);
});

// --- the map -----------------------------------------------------------------------

test('the map announces that it is generated, and anchors every claim it can', () => {
  const ledger = withClaims(observable, intent);
  const out = renderMap(ledger, { now: NOW, project: 'acme/api' });

  assert.match(out, /^# acme\/api — what this codebase is/);
  assert.match(out, /Do not edit/);
  assert.match(out, /`\.claude\/settings\.json:6`/, 'a doubted line must be one click from its evidence');
  assert.match(out, /_\(CLAUDE\.md\)_/);
  assert.match(out, /## design/);
  assert.match(out, /## enforcement/);
});

test('the map is stable, and topics are ordered', () => {
  const ledger = withClaims(observable, intent);
  assert.equal(renderMap(ledger, { now: NOW }), renderMap(ledger, { now: NOW }));
  const out = renderMap(ledger, { now: NOW });
  assert.ok(out.indexOf('## design') < out.indexOf('## enforcement'));
});

test('a stale claim is left out of the map rather than published as current', () => {
  let ledger = withClaims(observable);
  ledger = { ...ledger, claims: ledger.claims.map((c) => ({ ...c, status: 'stale' })) };
  assert.doesNotMatch(renderMap(ledger, { now: NOW }), /settings\.json/);
});

test('decisions are published, and so is what is still unsettled', () => {
  let ledger = withClaims(intent, observable);
  ledger = addQuestions(ledger, [
    { text: 'Which store is authoritative?', because: ['c1'] },
    { text: 'Is the cache still used?', because: ['c2'] },
  ]).ledger;
  ledger = answerQuestion(ledger, 'q1', 'Postgres is', { now: NOW }).ledger;

  const out = renderMap(ledger, { now: NOW });
  assert.match(out, /## Decisions/);
  assert.match(out, /Postgres is _\(2026-08-28\)_/);
  // A map that quietly omits the unsettled reads as complete, which is the one
  // thing it must never do.
  assert.match(out, /## Still unsettled/);
  assert.match(out, /Is the cache still used\? +`q2`/);
});

// --- the whole survey, through the real CLI ----------------------------------------
//
// The claim here is about *resumption*: every step persists, and a run picked up
// later knows where it got to. That is only observable across process
// boundaries, so this drives the actual command.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { git, withStubGh } from './ghstub.mjs';

const LEDGER = (repo) => join(repo, '_dev-workflow', 'artifacts', 'documentation', 'ledger.json');
const MAP = (repo) => join(repo, '_dev-workflow', 'artifacts', 'documentation', 'map.md');
const readLedger = (repo) => JSON.parse(readFileSync(LEDGER(repo), 'utf8'));

/** The scaffold, plus documents to survey. */
async function withDocs(files = {}) {
  const s = await withStubGh();
  const all = {
    'README.md': '# The project\n\nIt talks to Postgres.\n',
    'docs/design.md': '# Design\n\nWe chose Postgres for the JSON support.\n',
    'CHANGELOG.md': '# 1.0.0\n\n- things\n',
    'lib/db.js': 'module.exports = {};\n',
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    const abs = join(s.repo, path);
    await git(s.repo, 'rev-parse', '--show-toplevel');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  await git(s.repo, 'add', '-A');
  await git(s.repo, 'commit', '-m', 'chore(no-ticket): docs');
  return s;
}

test('scan inventories only the prose, and is safe to re-run', async () => {
  const { repo, dev } = await withDocs();

  const first = await dev(['ingest', 'scan']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /documents: 2/, 'the changelog and the source file are not documents');

  const paths = readLedger(repo).sources.map((s) => s.path);
  assert.deepEqual(paths, ['README.md', 'docs/design.md']);

  const second = await dev(['ingest', 'scan']);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /changed:/, 'nothing moved, so nothing is re-read');
});

test('a survey runs across separate invocations and remembers where it got to', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);

  const first = await dev(['ingest', 'next']);
  assert.match(first.stdout, /\[extract\].*README\.md/s);

  // Record what that document claims, then mark it read — two processes.
  const claims = join(repo, 'claims.json');
  writeFileSync(
    claims,
    JSON.stringify({
      claims: [
        { text: 'The service talks to Postgres', kind: 'observable', anchor: 'lib/db.js:1', source: 'README.md', topic: 'storage' },
      ],
    }),
  );
  const recorded = await dev(['ingest', 'record', `@${claims}`]);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.match(recorded.stdout, /1 claim\(s\), 0 question\(s\)/);
  await dev(['ingest', 'read', 'README.md']);

  // A fresh process picks up at the *second* document, not the first.
  const second = await dev(['ingest', 'next']);
  assert.match(second.stdout, /docs\/design\.md/);
  assert.doesNotMatch(second.stdout, /README\.md/);

  const status = await dev(['ingest']);
  assert.match(status.stdout, /sources: +2 \(1 read, 1 pending/);
  assert.match(status.stdout, /claims: +1 \(1 observable/);
});

test('next --all prints every pending document, and bare next is unchanged', async () => {
  const { dev } = await withDocs({ 'docs/ops.md': '# Ops\n\nDeploys via CI.\n' });
  await dev(['ingest', 'scan']);

  const all = await dev(['ingest', 'next', '--all']);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /README\.md/);
  assert.match(all.stdout, /docs\/design\.md/);
  assert.match(all.stdout, /docs\/ops\.md/);

  // Bare `next` still gives the single-document summary — additive, not replaced.
  const bare = await dev(['ingest', 'next']);
  assert.match(bare.stdout, /left: {2}2 document\(s\) after this one/);
  assert.doesNotMatch(bare.stdout, /docs\/ops\.md/);
});

test('enrich stores summary/keywords/headings on the matching source', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);

  const enrichment = join(repo, 'enrichment.json');
  writeFileSync(
    enrichment,
    JSON.stringify({ summary: 'What the project does.', keywords: ['postgres', 'storage'] }),
  );
  const result = await dev(['ingest', 'enrich', 'README.md', `@${enrichment}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /README\.md enriched/);

  const ledger = readLedger(repo);
  const readme = ledger.sources.find((s) => s.path === 'README.md');
  assert.equal(readme.summary, 'What the project does.');
  assert.deepEqual(readme.keywords, ['postgres', 'storage']);
});

test('enrich refuses an unknown path or a malformed payload, touching nothing', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);
  const before = readLedger(repo);

  const enrichment = join(repo, 'enrichment.json');
  writeFileSync(enrichment, JSON.stringify({ summary: 'x' }));
  const unknownPath = await dev(['ingest', 'enrich', 'nope.md', `@${enrichment}`]);
  assert.notEqual(unknownPath.code, 0);
  assert.match(unknownPath.stderr, /nope\.md/);

  writeFileSync(enrichment, JSON.stringify({ wordCount: -1 }));
  const badPayload = await dev(['ingest', 'enrich', 'README.md', `@${enrichment}`]);
  assert.notEqual(badPayload.code, 0);
  assert.match(badPayload.stderr, /wordCount/);

  assert.deepEqual(readLedger(repo), before, 'a refused enrich writes nothing');
});

test('arbitration blocks the emit until it is settled, and the answer persists', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);

  const batch = join(repo, 'batch.json');
  writeFileSync(
    batch,
    JSON.stringify({
      claims: [
        { text: 'Postgres was chosen for JSON support', kind: 'intent', source: 'docs/design.md', topic: 'storage' },
        { text: 'The cache is authoritative', kind: 'intent', source: 'README.md', topic: 'storage' },
      ],
      questions: [{ text: 'Which store is authoritative?', because: ['c1', 'c2'], options: ['Postgres', 'The cache'] }],
    }),
  );
  assert.equal((await dev(['ingest', 'record', `@${batch}`])).code, 0);
  for (const path of ['README.md', 'docs/design.md']) await dev(['ingest', 'read', path]);

  const blocked = await dev(['ingest', 'next']);
  assert.match(blocked.stdout, /\[arbitrate\]/);
  assert.match(blocked.stdout, /q1 +Which store is authoritative\?/);
  assert.match(blocked.stdout, /because: c1, c2/, 'a question must show what produced it');

  assert.equal((await dev(['ingest', 'answer', 'q1', 'Postgres is'])).code, 0);
  assert.match((await dev(['ingest', 'next'])).stdout, /\[emit\]/);

  // And it is durable across processes.
  const answered = readLedger(repo).questions[0];
  assert.deepEqual([answered.status, answered.answer], ['answered', 'Postgres is']);
  const again = await dev(['ingest', 'answer', 'q1', 'Actually the cache']);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /already answered/);
});

test('emit writes the map inside the payload, and nothing outside it', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);
  const batch = join(repo, 'b.json');
  writeFileSync(
    batch,
    JSON.stringify({
      claims: [{ text: 'It talks to Postgres', kind: 'observable', anchor: 'lib/db.js:1', source: 'README.md', topic: 'storage' }],
    }),
  );
  await dev(['ingest', 'record', `@${batch}`]);

  const before = readFileSync(join(repo, 'README.md'), 'utf8');
  const emitted = await dev(['ingest', 'emit']);

  assert.equal(emitted.code, 0, emitted.stderr);
  assert.match(emitted.stdout, /_dev-workflow\/artifacts\/documentation\/map\.md/);
  assert.match(readFileSync(MAP(repo), 'utf8'), /`lib\/db\.js:1`/);

  // The whole boundary, in one assertion: the project's own documentation is
  // never rewritten. Reorganisation is a proposal, not an edit.
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), before);
});

test('a rescan after a document changes reopens it and marks its claims stale', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);
  const batch = join(repo, 'b.json');
  writeFileSync(
    batch,
    JSON.stringify({
      claims: [{ text: 'It talks to Postgres', kind: 'observable', anchor: 'lib/db.js:1', source: 'README.md', topic: 'storage' }],
    }),
  );
  await dev(['ingest', 'record', `@${batch}`]);
  await dev(['ingest', 'read', 'README.md']);

  writeFileSync(join(repo, 'README.md'), '# The project\n\nIt talks to MySQL now.\n');
  const rescan = await dev(['ingest', 'scan']);
  assert.match(rescan.stdout, /changed: +README\.md/);

  const ledger = readLedger(repo);
  assert.equal(ledger.sources.find((s) => s.path === 'README.md').state, 'pending');
  assert.equal(ledger.claims[0].status, 'stale', 'kept, so an arbitration about it is not lost');
});

test('a malformed claims file is refused without touching the ledger', async () => {
  const { repo, dev } = await withDocs();
  await dev(['ingest', 'scan']);
  const before = readFileSync(LEDGER(repo), 'utf8');

  const bad = join(repo, 'bad.json');
  writeFileSync(bad, JSON.stringify({ claims: [{ text: 'Fast', kind: 'observable' }] }));
  const r = await dev(['ingest', 'record', `@${bad}`]);

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no anchor/);
  assert.equal(readFileSync(LEDGER(repo), 'utf8'), before, 'a refused batch writes nothing');
});

test('the commands say what to run when no survey exists yet', async () => {
  const { repo, dev } = await withDocs();
  const r = await dev(['ingest', 'next']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /dev\.mjs ingest scan/);
  assert.equal(existsSync(LEDGER(repo)), false);
});

test('assess reports the repo it looked at, and proposes rather than decides', async () => {
  const { dev } = await withDocs();
  const r = await dev(['assess']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^repo: +\. \(/m, 'the repo path resolves, rather than rendering empty');
  assert.match(r.stdout, /stage:/);
  assert.match(r.stdout, /proposal, not a finding/);
});
