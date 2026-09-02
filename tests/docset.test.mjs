/**
 * The documentation skeleton.
 *
 * Two things are asserted here that nothing else can assert. The first is that
 * the target set exists **once**: the names, the filenames and the default
 * `docs.set` all come from `lib/docset.mjs`, because the two issues that
 * promised this feature had already disagreed about a document's name before
 * either was built. The second is that a generated document cannot hold a
 * sentence nobody can check — `renderDocument` takes claims and nothing else,
 * and every line it emits carries an anchor or an attribution.
 *
 * The rest is refusals, which is where the value is: a wrong stage, an
 * unknown target, an anchor naming a file that is not there, and a document
 * somebody edited by hand that a re-render must not silently discard.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.mjs';
import {
  DEFAULT_DOC_SET,
  DOC_CATALOGUE,
  DOC_KEYS,
  docSetPaths,
  isPlaceholder,
  PLACEHOLDER_MARKER,
  renderDocument,
  resolveDocSet,
} from '../lib/docset.mjs';
import { classifyPath } from '../lib/ingest.mjs';
import { anchorPath } from '../scripts/cmd/common.mjs';
import { CONFIG, git, REPO_ROOT, withStubGh } from './ghstub.mjs';

const RECORDED = '2026-08-28T09:00:00.000Z';
const doc = (key) => resolveDocSet({}).documents.find((d) => d.key === key);

const claim = (over = {}) => ({
  id: 'c1',
  text: 'The entry point is src/app.mjs',
  kind: 'observable',
  anchor: 'src/app.mjs:1',
  source: 'derived',
  topic: 'shape',
  target: 'architecture',
  status: 'open',
  recordedAt: RECORDED,
  ...over,
});

// --- the set exists once -------------------------------------------------------

test('the catalogue is the set: keys, filenames and the default docs.set all come from it', () => {
  // Catalogue order is reading order: why it exists, then its internals, then
  // the surfaces it presents, then how it is run — and the pointer last.
  assert.deepEqual(DOC_KEYS, [
    'context',
    'architecture',
    'domain',
    'api',
    'ux',
    'operations',
    'testing',
    'security',
    'decisions',
  ]);
  assert.deepEqual(DEFAULT_DOC_SET, [
    'context',
    'architecture',
    'domain',
    'api',
    'ux',
    'operations',
    'testing',
    'security',
  ]);

  // Every writable entry is complete. A catalogue entry missing a purpose
  // renders a document with an empty subtitle rather than failing, so the
  // shape is asserted here rather than discovered in someone's docs/.
  for (const entry of DOC_CATALOGUE.filter((d) => d.writable)) {
    assert.ok(entry.file, `${entry.key} has no filename`);
    assert.ok(entry.title, `${entry.key} has no title`);
    assert.ok(entry.purpose, `${entry.key} has no purpose`);
  }

  // Not merely equal — the same array. `lib/config.mjs` importing its default
  // is what stops the list existing in two places, which is the whole point of
  // the file: the two issues that promised this feature already disagreed about
  // whether the fifth document was called "runbook" or "operations".
  assert.equal(DEFAULTS.docs.set, DEFAULT_DOC_SET);

  // `decisions` is a pointer, not a file this writes: ADRs are lib/adr.mjs's
  // job, numbered and frozen, and a second writer for them would be exactly the
  // duplication this file exists to prevent.
  assert.equal(DOC_CATALOGUE.find((d) => d.key === 'decisions').writable, false);
  assert.equal(doc('decisions').path, 'docs/decisions');
});

test('lib/docset.mjs is pure: no imports, no filesystem, no clock', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'docset.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /^\s*import\s/m, 'a pure catalogue imports nothing');
  assert.doesNotMatch(code, /new Date\(|Date\.now/, 'a clock here would make docs check fail the next day');
  assert.doesNotMatch(code, /readFileSync|writeFileSync|existsSync|process\./);
});

test('the document names are a list in exactly one file', () => {
  // Anything holding two of the catalogue's filenames is a second copy of the
  // set, which is the drift this module exists to prevent. Asserted on the
  // filenames rather than the keys because `lib/ingest.mjs` legitimately knows
  // the word "architecture" — it is one of the stems that makes a stray file a
  // document.
  const files = DOC_CATALOGUE.filter((d) => d.writable).map((d) => d.file);
  const offenders = [];

  for (const rel of sources()) {
    if (rel === 'lib/docset.mjs') continue;
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (files.filter((f) => text.includes(f)).length >= 2) offenders.push(rel);
  }

  assert.deepEqual(offenders, [], 'the target set must be defined in lib/docset.mjs alone');
});

/** Every shipped `.mjs` under lib/ and scripts/. */
function sources(dir = '', out = []) {
  for (const name of readdirSync(join(REPO_ROOT, dir || '.'))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (dir === '' && !['lib', 'scripts'].includes(name)) continue;
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) sources(rel, out);
    else if (rel.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

// --- the collision the filename sidesteps --------------------------------------

test('every path the catalogue can emit is something ingest scan would inventory', () => {
  // Over `docSetPaths`, not over the default set: it resolves the **whole**
  // catalogue, so an entry a project has to opt into is covered too. That is
  // the security-model.md lesson (#41) generalised — `GENERATED` tests the
  // basename before the `docs/` rule, so a target the set emits can be a
  // document `ingest scan` never inventories, and nothing but this notices.
  //
  // The decisions pointer is the one exclusion: it is a directory, not a file,
  // and there is no classification to make about it.
  const decisions = resolveDocSet({}).documents.find((d) => !d.writable).path;
  const paths = docSetPaths({}).filter((p) => p !== decisions);

  assert.equal(paths.length, DOC_KEYS.length - 1, 'docSetPaths must cover the whole catalogue');
  for (const path of paths) {
    assert.equal(classifyPath(path), 'doc', `${path} is invisible to ingest scan`);
  }
});

test('the security document is security-model.md, because security.md is excluded', () => {
  assert.equal(doc('security').path, 'docs/security-model.md');

  // `lib/ingest.mjs`'s GENERATED list tests /^security\.md$/i against the
  // *basename*, before the docs/ rule. It was written for a root-level GitHub
  // SECURITY.md policy file, and as written it swallows a real security
  // document under docs/ too. Narrowing it would change what ingest scan finds
  // in every already-surveyed project, so the filename sidesteps it — and this
  // is the test that fails if somebody renames it back.
  assert.equal(classifyPath('docs/security.md'), 'other');
  assert.equal(classifyPath('docs/security-model.md'), 'doc');
});

// --- docs.set is an array, and that is load-bearing ----------------------------

test('a project listing three documents gets exactly three', () => {
  const r = resolveDocSet({ docs: { set: ['architecture', 'testing', 'operations'] } });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.documents.filter((d) => d.writable).map((d) => d.key), ['architecture', 'testing', 'operations']);
});

test('docs.set as an object is refused, since deepMerge would fold it into the defaults', () => {
  const r = resolveDocSet({ docs: { set: { architecture: true } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be an array/);
  // Derived, not restated: the literal list is asserted once, above. A second
  // copy here is the drift lib/docset.mjs exists to prevent.
  assert.ok(r.error.endsWith(`Known keys: ${DOC_KEYS.join(', ')}`), r.error);
});

test('an unknown document is an error naming the known ones, never a guess', () => {
  const r = resolveDocSet({ docs: { set: ['runbook'] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown document "runbook"/);
  assert.match(r.error, /operations/);
});

test('the decisions pointer comes along whatever docs.set says', () => {
  const r = resolveDocSet({ docs: { set: ['architecture'], decisionsDir: 'adr' } });
  assert.ok(r.ok, r.error);
  const pointer = r.documents.find((d) => d.key === 'decisions');
  assert.equal(pointer.path, 'adr');
  assert.match(pointer.pointer, /adr new/);
});

test('docs.dir moves every writable document at once', () => {
  const r = resolveDocSet({ docs: { dir: 'documentation/' } });
  assert.ok(r.ok, r.error);
  assert.equal(r.documents.find((d) => d.key === 'domain').path, 'documentation/domain.md');
});

// --- the renderer has no free-prose slot ---------------------------------------

test('every body line is a claim carrying its anchor or its attribution', () => {
  const out = renderDocument(doc('architecture'), {
    claims: [
      claim(),
      claim({ id: 'c2', kind: 'intent', anchor: null, source: 'ayoub', text: 'One module, so a reader can hold it all' }),
    ],
  });

  for (const line of out.split('\n')) {
    if (!line.startsWith('- ')) continue;
    assert.ok(/ — `[^`]+`$/.test(line) || / _\([^)]+\)_$/.test(line), `unevidenced line: ${line}`);
  }
  assert.match(out, /- The entry point is src\/app\.mjs — `src\/app\.mjs:1`/);
  assert.match(out, /- One module, so a reader can hold it all _\(ayoub, 2026-08-28\)_/);
});

test('renderDocument accepts no prose: an extra argument cannot reach the output', () => {
  const withProse = renderDocument(doc('domain'), {
    claims: [claim({ target: 'domain' })],
    body: 'A paragraph somebody wanted in here',
    prose: 'or here',
    text: 'or here',
  });
  assert.doesNotMatch(withProse, /somebody wanted|or here/);
});

test('a document with nothing recorded says so rather than reading as complete', () => {
  const out = renderDocument(doc('operations'), {});
  assert.match(out, /## Not yet established/);
  assert.ok(isPlaceholder(out));
  assert.ok(out.includes(PLACEHOLDER_MARKER));
});

test('open questions are printed, never hidden', () => {
  const out = renderDocument(doc('architecture'), {
    claims: [claim()],
    unsettled: [{ id: 'q1', text: 'Is the cache authoritative?' }],
  });
  assert.match(out, /## Not yet established/);
  assert.match(out, /- Is the cache authoritative\? +`q1`/);
  assert.ok(!isPlaceholder(out), 'a document with claims is not a stub');
});

test('a stale claim is left out rather than published as current', () => {
  const out = renderDocument(doc('architecture'), { claims: [claim({ status: 'stale' })] });
  assert.doesNotMatch(out, /entry point/);
  assert.ok(isPlaceholder(out), 'nothing live left, so it is a stub again');
});

test('nothing in a rendered document comes from the clock', () => {
  const claims = [
    claim({ id: 'c1', kind: 'intent', anchor: null, source: 'ayoub', recordedAt: '2026-01-02T10:00:00.000Z' }),
    claim({ id: 'c2', text: 'It runs on node 22', anchor: 'package.json:40', recordedAt: RECORDED }),
  ];
  const first = renderDocument(doc('architecture'), { claims });
  const second = renderDocument(doc('architecture'), { claims });
  assert.equal(first, second);

  // Every date in the output is one the ledger carries. A rendered `today`
  // would make `docs check` fail the day after the document was written.
  const dates = [...first.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(dates)].sort(), ['2026-01-02']);
});

// --- what an anchor is ---------------------------------------------------------

test('an anchor is a path, or a command, and the two are told apart', () => {
  assert.equal(anchorPath('src/app.mjs:1'), 'src/app.mjs');
  assert.equal(anchorPath('lib/ingest.mjs:63-70'), 'lib/ingest.mjs');
  assert.equal(anchorPath('package.json'), 'package.json');
  assert.equal(anchorPath('.claude/settings.json:6'), '.claude/settings.json');

  // A false refusal is worse than a miss: it would block a claim that was
  // correctly evidenced by the command that proves it.
  assert.equal(anchorPath('npm test'), null);
  assert.equal(anchorPath('git ls-files'), null);
  assert.equal(anchorPath('make'), null);
  assert.equal(anchorPath('https://example.invalid/x'), null);
  assert.equal(anchorPath(''), null);
  assert.equal(anchorPath(null), null);
});

// --- the commands --------------------------------------------------------------

const GREENFIELD = { ...CONFIG, stage: 'greenfield' };
const read = (repo, rel) => readFileSync(join(repo, rel), 'utf8');
const ledgerOf = (repo) =>
  JSON.parse(read(repo, join('_dev-workflow', 'artifacts', 'documentation', 'ledger.json')));

/** A greenfield project with a source file real enough to anchor a claim to. */
async function greenfield(config = GREENFIELD) {
  const s = await withStubGh({ config });
  writeFileSync(join(s.repo, 'src.mjs'), 'export const x = 1;\n');
  writeFileSync(join(s.repo, 'README.md'), '# The project\n');
  await git(s.repo, 'add', '-A');
  await git(s.repo, 'commit', '-m', 'chore(no-ticket): scaffold');
  return s;
}

const claimsFile = (s, claims) => {
  const path = join(s.root, 'claims.json');
  writeFileSync(path, JSON.stringify({ claims }));
  return `@${path}`;
};

test('init refuses on brownfield, naming the skill that reads instead of writing', async () => {
  const { repo, dev } = await greenfield({ ...CONFIG, stage: 'brownfield' });
  const r = await dev(['docs', 'init']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /brownfield/);
  assert.match(r.stderr, /dev-ingest-docs/);
  assert.equal(existsSync(join(repo, 'docs')), false, 'a refusal writes nothing');
});

test('init refuses when nobody has settled the stage, and never infers it', async () => {
  const bare = { ...CONFIG };
  delete bare.stage;
  const { repo, dev } = await greenfield(bare);
  const r = await dev(['docs', 'init']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"stage"/);
  assert.match(r.stderr, /dev-init/);
  assert.equal(existsSync(join(repo, 'docs')), false);
});

test('init names every path, creates only what is missing, and is safe to re-run', async () => {
  const { repo, dev } = await greenfield();

  const first = await dev(['docs', 'init']);
  assert.equal(first.code, 0, first.stderr);
  for (const d of resolveDocSet({}).documents.filter((x) => x.writable)) {
    assert.match(first.stdout, new RegExp(`created: +${d.path.replace('.', '\\.')}`));
    assert.ok(existsSync(join(repo, d.path)));
  }
  // The pointer is named and nothing is written for it.
  assert.match(first.stdout, /pointer: +docs\/decisions/);
  assert.equal(existsSync(join(repo, 'docs', 'decisions')), false);

  writeFileSync(join(repo, 'docs', 'domain.md'), 'mine\n');
  const second = await dev(['docs', 'init']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /kept: +docs\/domain\.md/);
  assert.equal(read(repo, 'docs/domain.md'), 'mine\n', 'a file that exists is never overwritten');
});

test('init registers what it wrote, so ingest scan never offers it back for extraction', async () => {
  const { repo, dev } = await greenfield();
  await dev(['docs', 'init']);

  const generated = ledgerOf(repo).sources.filter((s) => s.state === 'generated');
  assert.deepEqual(
    generated.map((s) => s.path).sort(),
    resolveDocSet({}).documents.filter((d) => d.writable).map((d) => d.path).sort(),
    'every writable document in the set is registered with the sha256 init wrote',
  );

  await git(repo, 'add', '-A');
  const scan = await dev(['ingest', 'scan']);
  assert.equal(scan.code, 0, scan.stderr);
  const next = await dev(['ingest', 'next']);
  assert.doesNotMatch(next.stdout, /docs\//, 'reading our own output back in compounds every mistake it made');

  // A hand-edit is a different matter: the ledger has never seen that prose, so
  // it goes back in the queue with its claims marked stale.
  writeFileSync(join(repo, 'docs', 'operations.md'), `${read(repo, 'docs/operations.md')}\nIt deploys on Fridays.\n`);
  await git(repo, 'add', '-A');
  const rescan = await dev(['ingest', 'scan']);
  assert.match(rescan.stdout, /changed: +1 — docs\/operations\.md/);
  assert.equal(ledgerOf(repo).sources.find((s) => s.path === 'docs/operations.md').state, 'pending');
});

test('record refuses an unanchored observable claim, exactly as ingest record does', async () => {
  const s = await greenfield();
  const bad = [{ text: 'Sessions live in Redis', kind: 'observable', target: 'architecture' }];

  const viaDocs = await s.dev(['docs', 'record', claimsFile(s, bad)]);
  assert.equal(viaDocs.code, 1);
  assert.match(viaDocs.stderr, /has no anchor/);

  await s.dev(['ingest', 'scan']);
  const viaIngest = await s.dev(['ingest', 'record', claimsFile(s, bad)]);
  assert.equal(viaIngest.code, 1);
  assert.match(viaIngest.stderr, /has no anchor/);
});

test('record refuses a claim aimed at a document the project does not have', async () => {
  const s = await greenfield();
  const r = await s.dev([
    'docs',
    'record',
    claimsFile(s, [{ text: 'x', kind: 'observable', anchor: 'src.mjs:1', target: 'runbook' }]),
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /targets "runbook"/);
  assert.ok(r.stderr.trim().endsWith(`docs.set: ${DEFAULT_DOC_SET.join(', ')}`), r.stderr);
});

test('record refuses a claim with no target rather than filing it nowhere', async () => {
  const s = await greenfield();
  const r = await s.dev(['docs', 'record', claimsFile(s, [{ text: 'x', kind: 'observable', anchor: 'src.mjs:1' }])]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /names no target/);
});

test('an anchor naming a file that is not in the repo is refused, on both record paths', async () => {
  const s = await greenfield();
  const invented = [
    { text: 'Sessions live in Redis', kind: 'observable', anchor: 'src/session.ts:34', target: 'architecture' },
  ];

  const viaDocs = await s.dev(['docs', 'record', claimsFile(s, invented)]);
  assert.equal(viaDocs.code, 1);
  assert.match(viaDocs.stderr, /src\/session\.ts/);
  assert.match(viaDocs.stderr, /not in the repo/);

  await s.dev(['ingest', 'scan']);
  const viaIngest = await s.dev(['ingest', 'record', claimsFile(s, invented)]);
  assert.equal(viaIngest.code, 1);
  assert.match(viaIngest.stderr, /not in the repo/);

  // The command that proves a claim is still a legitimate anchor.
  const ok = await s.dev([
    'docs',
    'record',
    claimsFile(s, [{ text: 'The suite passes', kind: 'observable', anchor: 'npm test', target: 'testing' }]),
  ]);
  assert.equal(ok.code, 0, ok.stderr);
});

test('a document that was never scaffolded is not the same failure as one that drifted', async () => {
  // Widening the catalogue (#53) makes this the common case rather than an
  // edge one: a project that has never set `docs.set` gains three documents on
  // update, and `docs check` exits 1 for every one of them. Reported as drift
  // that would read as though something went wrong — the silent-behaviour
  // change the manifest exists to prevent, arriving through a default.
  //
  // The ledger is what tells the two apart. It records each document `docs
  // init` generated, with the sha256 written to it, so absent-from-disk **and**
  // absent-from-the-ledger is a document nobody has ever asked for.
  const s = await greenfield({ ...GREENFIELD, docs: { set: ['architecture'] } });
  const { repo, dev } = s;

  const never = await dev(['docs', 'check']);
  assert.equal(never.code, 1, 'the exit code stays 1: the document is still missing');
  assert.match(never.stderr, /docs\/architecture\.md — has never been scaffolded/);
  assert.match(never.stderr, /dev\.mjs docs init/);
  assert.doesNotMatch(never.stderr, /drift|moved on|edited by hand/);

  // Scaffolded and then deleted is the opposite fact: the ledger has claims and
  // a sha256 for a file that is gone, so `docs render` puts it back. `docs
  // init` would rewrite it as a stub and lose them.
  await dev(['docs', 'init']);
  rmSync(join(repo, 'docs', 'architecture.md'));

  const gone = await dev(['docs', 'check']);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /docs\/architecture\.md — was generated and is now missing/);
  assert.match(gone.stderr, /dev\.mjs docs render architecture/);
  assert.doesNotMatch(gone.stderr, /never been scaffolded/);
});

test('a brownfield project is not told to run the command that refuses brownfield projects', async () => {
  // The two halves of #53 meet here. Widening the catalogue gives every project
  // documents it has never scaffolded, and `docs check` reports each one — but
  // `docs init` refuses anything that is not greenfield, so a brownfield
  // project was handed a recovery command that answers the failure by refusing.
  // Stage decides the route, from the same predicate `init` refuses through.
  const { dev } = await greenfield({ ...CONFIG, stage: 'brownfield', docs: { set: ['architecture'] } });

  const r = await dev(['docs', 'check']);
  assert.equal(r.code, 1, 'still missing, so still 1');
  assert.match(r.stderr, /docs\/architecture\.md — has never been scaffolded/);
  assert.match(r.stderr, /record claims against "architecture"/);
  assert.match(r.stderr, /dev\.mjs docs render architecture/);
  // The command it cannot run must not be the one it is pointed at.
  assert.doesNotMatch(r.stderr, /dev\.mjs docs init/);
});

test('check goes green only when the documents match the ledger, and names the one that does not', async () => {
  // One document in the set, so the assertions are about this document's state
  // and not about the four that have not been created yet.
  const s = await greenfield({ ...GREENFIELD, docs: { set: ['architecture'] } });
  const { repo, dev } = s;
  await dev(['docs', 'init']);

  const stub = await dev(['docs', 'check']);
  assert.equal(stub.code, 1);
  assert.match(stub.stderr, /docs\/architecture\.md — still a stub/);

  const record = (text, anchor) =>
    dev(['docs', 'record', claimsFile(s, [{ text, kind: 'observable', anchor, target: 'architecture', topic: 'shape' }])]);

  await record('The entry point is src.mjs', 'src.mjs:1');
  assert.equal((await dev(['docs', 'render'])).code, 0);
  assert.equal((await dev(['docs', 'check'])).code, 0);

  // A claim recorded and not rendered is drift, and it is a different failure
  // from a hand-edit: the file is still ours, the ledger has simply moved on.
  await record('It exports one binding', 'src.mjs:1');
  const drifted = await dev(['docs', 'check']);
  assert.equal(drifted.code, 1);
  assert.match(drifted.stderr, /the ledger has moved on/);

  assert.equal((await dev(['docs', 'render'])).code, 0);
  const green = await dev(['docs', 'check']);
  assert.equal(green.code, 0, green.stderr);

  // Rendering again a month later produces the same bytes: nothing in the
  // document came from the clock.
  const before = read(repo, 'docs/architecture.md');
  const again = await dev(['docs', 'render']);
  assert.match(again.stdout, /unchanged: +docs\/architecture\.md/);
  assert.equal(read(repo, 'docs/architecture.md'), before);
  assert.equal((await dev(['docs', 'check'])).code, 0);
});

test('render refuses to discard a hand-edit the ledger has never seen', async () => {
  const { repo, dev } = await greenfield();
  await dev(['docs', 'init', '--only', 'testing']);
  const edited = `${read(repo, 'docs/testing.md')}\nWe test by hand.\n`;
  writeFileSync(join(repo, 'docs', 'testing.md'), edited);

  const r = await dev(['docs', 'render', 'testing']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /refused: +docs\/testing\.md/);
  assert.equal(read(repo, 'docs/testing.md'), edited, 'the edit survives until it is absorbed');
  assert.match(r.stdout, /ingest scan/);
});

test('docs writes nothing outside docs/ and the artifact directory', async () => {
  const s = await greenfield();
  const { repo, dev } = s;
  const before = snapshot(repo);

  await dev(['docs', 'init']);
  await dev([
    'docs',
    'record',
    claimsFile(s, [
      { text: 'The entry point is src.mjs', kind: 'observable', anchor: 'src.mjs:1', target: 'architecture', topic: 'shape' },
    ]),
  ]);
  await dev(['docs', 'render']);

  const after = snapshot(repo);
  for (const [path, hash] of Object.entries(before)) {
    assert.equal(after[path], hash, `${path} changed`);
  }
  const written = Object.keys(after).filter((p) => !(p in before));
  for (const path of written) {
    assert.ok(
      path.startsWith('docs/') || path.startsWith('_dev-workflow/artifacts/documentation/'),
      `${path} is outside what this command may write`,
    );
  }
  assert.equal(after['README.md'], before['README.md']);
});

/** Every tracked-ish file under the repo, by content, ignoring git's own state. */
function snapshot(repo, dir = '', out = {}) {
  for (const name of readdirSync(join(repo, dir || '.'))) {
    if (name === '.git') continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(repo, rel)).isDirectory()) snapshot(repo, rel, out);
    else out[rel] = readFileSync(join(repo, rel), 'utf8');
  }
  return out;
}
