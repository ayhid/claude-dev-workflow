/**
 * The documentation skeleton for a greenfield project.
 *
 *   dev.mjs docs                 which documents exist, which are stubs
 *   dev.mjs docs init [--only K] scaffold the missing ones; idempotent
 *   dev.mjs docs record @file    add claims, each naming the document it belongs in
 *   dev.mjs docs render [KEY]    re-render from the ledger
 *   dev.mjs docs check           exit 1 if a document drifted or is still a stub
 *
 * `/dev-ingest-docs` reads an existing project's documentation into claims.
 * This is the same machinery pointed the other way: **ingest turns documents
 * into claims, `docs` turns claims into documents.** One ledger, one validator,
 * one renderer — which is why `record` goes through `lib/ingest.mjs`'s
 * `validateClaim` rather than growing a second idea of what a claim is.
 *
 * It writes markdown into the project's own `docs/`, which is outside
 * `_dev-workflow/**` — and that is correct. `isOwnedPath` binds the
 * **installer**, which must never decide on its own to write somewhere it does
 * not own; this is a runtime command acting on the user's explicit request, the
 * way `adr new` and `note` already do. Nothing here loosens that boundary.
 *
 * No tracker and no network: it calls `loadConfig()` directly rather than
 * `context()`, as `scripts/cmd/adr.mjs` does.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../../lib/config.mjs';
import { isPlaceholder, renderDocument, resolveDocSet } from '../../lib/docset.mjs';
import { addClaims, emptyLedger, GENERATED_STATE } from '../../lib/ingest.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { readArg, refuseMissingAnchors, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

const USAGE = `usage: dev.mjs docs <verb>

  (no verb)              which documents exist, and what backs each one
  init [--only K,...]    scaffold the missing documents; never overwrites
  record <@file>         add claims, as JSON; each claim names a target
  render [KEY]           re-render one document, or every one in docs.set
  check                  exit 1 if a document drifted from the ledger`;

export async function run(argv) {
  const [verb, ...rest] = argv;
  if (verb === '--help' || verb === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { config, root } = loadConfig();
  const set = resolveDocSet(config);
  if (!set.ok) throw new UserError(set.error);
  const documents = set.documents;

  switch (verb ?? 'status') {
    case 'status':
      return cmdStatus({ root, documents });
    case 'init':
      return cmdInit({ config, root, documents, argv: rest });
    case 'record':
      return cmdRecord({ root, documents, argv: rest });
    case 'render':
      return cmdRender({ root, documents, argv: rest });
    case 'check':
      return cmdCheck({ config, root, documents });
    default:
      throw new UserError(`unknown verb "${verb}"\n\n${USAGE}`);
  }
}

// --- the ledger ----------------------------------------------------------------
//
// The same file `ingest` writes, read through the same path constant. Two
// ledgers would be two answers to "what does this project claim about itself".

const ledgerPath = (root) => join(root, ARTIFACT_DIR, LEDGER);

function loadLedger(root) {
  const path = ledgerPath(root);
  if (!existsSync(path)) return emptyLedger({});
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UserError(
      `${path} is not readable JSON: ${err.message}\n` +
        'It is the record of everything already decided — repair it by hand rather than deleting it.',
    );
  }
}

function saveLedger(root, ledger) {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** The claims and open questions belonging to one document. */
function contentFor(ledger, key) {
  const claims = (ledger.claims ?? []).filter((c) => c.target === key);
  const ids = new Set(claims.map((c) => c.id));
  const unsettled = (ledger.questions ?? []).filter(
    (q) => q.status === 'open' && (q.because ?? []).some((id) => ids.has(id)),
  );
  return { claims, unsettled };
}

const render = (ledger, doc) => renderDocument(doc, contentFor(ledger, doc.key));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const writable = (documents) => documents.filter((d) => d.writable);
const label = (word) => `${word}:`.padEnd(11);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The hash this tool recorded when it last wrote `path`, or null. */
const generatedSha = (ledger, path) =>
  (ledger.sources ?? []).find((s) => s.path === path && s.state === GENERATED_STATE)?.sha256 ?? null;

/**
 * Register a document this command just wrote, with the bytes it wrote.
 *
 * Two jobs in one entry. It keeps `ingest scan` from offering our own output
 * back for extraction — `classifyPath('docs/architecture.md')` is `doc`, and
 * `docs/**` is not excluded the way `_dev-workflow/artifacts/**` is — and it is
 * what lets a later `render` tell a file it wrote from one somebody edited.
 */
function registerGenerated(sources, path, text) {
  const entry = {
    path,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    state: GENERATED_STATE,
    readAt: null,
  };
  const at = sources.findIndex((s) => s.path === path);
  if (at >= 0) sources[at] = entry;
  else sources.push(entry);
  return sources;
}

// --- status --------------------------------------------------------------------

function cmdStatus({ root, documents }) {
  const ledger = loadLedger(root);
  const L = [`${'DOCUMENT'.padEnd(14)}${'CLAIMS'.padEnd(8)}${'STATE'.padEnd(12)}PATH`, '-'.repeat(72)];

  for (const doc of documents) {
    if (!doc.writable) {
      L.push(`${doc.key.padEnd(14)}${'-'.padEnd(8)}${'pointer'.padEnd(12)}${doc.path}   → ${doc.pointer}`);
      continue;
    }
    const abs = resolve(root, doc.path);
    const { claims } = contentFor(ledger, doc.key);
    let state = 'missing';
    if (existsSync(abs)) {
      const text = readFileSync(abs, 'utf8');
      state = isPlaceholder(text) ? 'stub' : text === render(ledger, doc) ? 'current' : 'drifted';
    }
    L.push(`${doc.key.padEnd(14)}${String(claims.length).padEnd(8)}${state.padEnd(12)}${doc.path}`);
  }

  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

// --- init ----------------------------------------------------------------------

/**
 * Scaffold the documents that do not exist yet.
 *
 * Never overwrites, and never overwrites *a file it did not generate* even when
 * asked to re-render: a project that already has a hand-written
 * `docs/architecture.md` gets it reported, not replaced. Absorbing an existing
 * document is `/dev-ingest-docs`'s job and this refuses to do it badly.
 */
function cmdInit({ config, root, documents, argv }) {
  requireGreenfield(config);

  const only = takeOnly(argv, documents);
  const targets = writable(documents).filter((d) => !only || only.includes(d.key));

  let ledger = loadLedger(root);
  const written = [];
  const kept = [];
  const sources = [...(ledger.sources ?? [])];

  for (const doc of targets) {
    const abs = resolve(root, doc.path);
    if (existsSync(abs)) {
      kept.push(doc.path);
      continue;
    }
    const text = render(ledger, doc);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    written.push(doc.path);
    registerGenerated(sources, doc.path, text);
  }

  if (written.length) {
    ledger = { ...ledger, sources: sources.sort(byPath) };
    saveLedger(root, ledger);
  }

  const L = [];
  for (const path of written) L.push(`created:  ${path}`);
  for (const path of kept) L.push(`kept:     ${path}   (already exists — not touched)`);

  const pointer = documents.find((d) => !d.writable && (!only || only.includes(d.key)));
  if (pointer) L.push(`pointer:  ${pointer.path}   → ${pointer.pointer}`);

  L.push('');
  if (!written.length) {
    L.push('Nothing to create.');
  } else {
    L.push('Every document is a stub until claims are recorded against it, and every line one');
    L.push('ends up with carries its own evidence: an anchor — the file:line that would show it');
    L.push('false — or the name of whoever asserted it. Record them, then render:');
    L.push('');
    L.push('  dev.mjs docs record @claims.json');
    L.push('  dev.mjs docs render');
    L.push('  dev.mjs docs check');
  }

  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

/**
 * Stage is confirmed, never inferred.
 *
 * The mirror of `/dev-ingest-docs` §0 refusing a greenfield project. A wrong
 * stage sends the session down the wrong branch and nothing downstream would
 * notice, so `dev.mjs assess` proposes and a human settles it (rule 2).
 */
const isGreenfield = (config) => config.stage === 'greenfield';

function requireGreenfield(config) {
  if (isGreenfield(config)) return;
  if (config.stage === 'brownfield') {
    throw new UserError(
      'this project is configured as brownfield — it already has documentation to read.\n' +
        'Run /dev-ingest-docs, which absorbs what is there rather than writing over it.',
    );
  }
  throw new UserError(
    'no "stage" is set in .dev-workflow.json, and it is not inferred from here.\n' +
      'Run "dev.mjs assess" to see the signals, then /dev-init to settle it — a wrong stage\n' +
      'sends this down the wrong branch and nothing downstream would notice.',
  );
}

/** `--only a,b` restricted to keys the project actually configured. */
function takeOnly(argv, documents) {
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--only') throw new UserError(`unknown argument '${argv[i]}'\n\n${USAGE}`);
    const value = argv[++i];
    if (!value) throw new UserError('--only needs a comma-separated list of document keys');
    only = value.split(',').map((k) => k.trim()).filter(Boolean);
  }
  if (!only) return null;

  const known = documents.map((d) => d.key);
  const unknown = only.filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new UserError(`--only names ${unknown.join(', ')}, which is not in docs.set: ${known.join(', ')}`);
  }
  return only;
}

// --- record --------------------------------------------------------------------

function cmdRecord({ root, documents, argv }) {
  const raw = argv[0];
  if (!raw) throw new UserError('usage: dev.mjs docs record @claims.json');

  let payload;
  try {
    payload = JSON.parse(readArg(raw, 'claims file'));
  } catch (err) {
    throw new UserError(`the claims file is not valid JSON: ${err.message}`);
  }

  const incoming = payload.claims ?? [];
  refuseMissingAnchors(incoming, root);

  const targets = writable(documents).map((d) => d.key);
  const ledger = loadLedger(root);
  const result = addClaims(ledger, incoming, { targets, requireTarget: true });
  if (!result.ok) throw new UserError(result.error);

  saveLedger(root, result.ledger);

  const counted = new Map();
  for (const claim of result.added) counted.set(claim.target, (counted.get(claim.target) ?? 0) + 1);
  const summary = [...counted.entries()].sort().map(([k, n]) => `${k}: ${n}`).join(', ');

  process.stdout.write(
    `dev docs: ${result.added.length} claim(s) recorded${summary ? ` (${summary})` : ''}\n` +
      `dev docs: run "dev.mjs docs render" to fold them into the documents\n`,
  );
  return 0;
}

// --- render --------------------------------------------------------------------

function cmdRender({ root, documents, argv }) {
  const key = argv[0];
  if (key && key.startsWith('--')) throw new UserError(`unknown argument '${key}'\n\n${USAGE}`);

  const ledger = loadLedger(root);
  const targets = writable(documents).filter((d) => !key || d.key === key);
  if (key && !targets.length) {
    throw new UserError(`"${key}" is not a document in docs.set: ${writable(documents).map((d) => d.key).join(', ')}`);
  }

  const L = [];
  const sources = [...(ledger.sources ?? [])];
  let wrote = false;

  for (const doc of targets) {
    const abs = resolve(root, doc.path);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;

    // A file we did not write, or one somebody has edited since we wrote it, is
    // not ours to overwrite. Re-rendering over a hand-edit would discard prose
    // the ledger has never seen — and `ingest scan` is the path that absorbs
    // it, so the edit has to survive until it does.
    if (before !== null && sha256(before) !== generatedSha(ledger, doc.path)) {
      L.push(`${label('refused')}${doc.path}   (edited by hand since it was generated, or never generated)`);
      continue;
    }

    const text = render(ledger, doc);
    if (before === text) {
      L.push(`${label('unchanged')}${doc.path}`);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    registerGenerated(sources, doc.path, text);
    wrote = true;
    L.push(`${label(before === null ? 'created' : 'rendered')}${doc.path}`);
  }

  if (wrote) saveLedger(root, { ...ledger, sources: sources.sort(byPath) });

  const refused = L.filter((line) => line.startsWith('refused:')).length;
  if (refused) {
    L.push('');
    L.push('Absorb the edits with "dev.mjs ingest scan" and record what they claim, or delete the');
    L.push('file to have it regenerated.');
  }

  process.stdout.write(`${L.join('\n')}\n`);
  return refused ? 1 : 0;
}

// --- check ---------------------------------------------------------------------

/**
 * Is every document what the ledger says it should be?
 *
 * Three ways to fail, and a stub is one of them on purpose: a scaffolded
 * document that counted as finished the moment it existed would make this check
 * say nothing at all.
 */
function cmdCheck({ config, root, documents }) {
  const ledger = loadLedger(root);
  const problems = [];

  for (const doc of writable(documents)) {
    const abs = resolve(root, doc.path);
    if (!existsSync(abs)) {
      // Absent from disk is two different facts, and the ledger is what tells
      // them apart. A document it has never registered as generated is one
      // nobody has been asked about — which is every project's experience of a
      // widened catalogue (#53) — so it is reported as work not started, not as
      // drift. One the ledger *did* generate has claims and a sha256 behind it,
      // so `docs render` puts the file back; `docs init` would rewrite it as a
      // stub and lose them. The exit code is 1 either way: it is still missing.
      //
      // Which way to start it is the project's stage, and it has to be, because
      // `docs init` refuses everything that is not greenfield. Printing it
      // regardless would hand a brownfield project — the one a widened
      // catalogue reaches through an update it never asked for — a command that
      // answers the failure by refusing. There the route is the one `docs
      // status` and the stub message already name: claims first, then render.
      problems.push(
        generatedSha(ledger, doc.path) !== null
          ? `${doc.path} — was generated and is now missing; run: dev.mjs docs render ${doc.key}`
          : isGreenfield(config)
            ? `${doc.path} — has never been scaffolded; run: dev.mjs docs init`
            : `${doc.path} — has never been scaffolded; record claims against "${doc.key}", then run: dev.mjs docs render ${doc.key}`,
      );
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    if (isPlaceholder(text)) {
      problems.push(`${doc.path} — still a stub; record claims against "${doc.key}"`);
      continue;
    }
    if (text !== render(ledger, doc)) {
      const edited = sha256(text) !== generatedSha(ledger, doc.path);
      problems.push(
        edited
          ? `${doc.path} — edited by hand; absorb it with "dev.mjs ingest scan" and record what it claims`
          : `${doc.path} — the ledger has moved on; run: dev.mjs docs render ${doc.key}`,
      );
    }
  }

  if (!problems.length) {
    process.stdout.write(`dev docs: ${writable(documents).length} document(s) match the ledger\n`);
    return 0;
  }

  process.stderr.write(`dev docs: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  return 1;
}
