/**
 * Absorb a brownfield project's documentation, one step at a time.
 *
 *   dev.mjs ingest              where the survey stands, and what is next
 *   dev.mjs ingest scan         inventory the documents (re-runnable)
 *   dev.mjs ingest next         the single next unit of work
 *   dev.mjs ingest record @file claims and questions, as JSON
 *   dev.mjs ingest read <path>  mark one document read
 *   dev.mjs ingest answer <id> "<text>"
 *   dev.mjs ingest emit         regenerate the map from the ledger
 *
 * A large codebase cannot be understood in one pass, and a process that demands
 * one gets abandoned halfway with nothing to show. So everything is persisted
 * after every step: run it for ten minutes, come back next week, and `next`
 * still knows where it got to.
 *
 * ## What it will not do
 *
 * **It never rewrites the project's documentation.** Reorganisation is a
 * proposal — the map, the contradictions and the open questions — and applying
 * it is ordinary work the user approves file by file. The tool writes to
 * `_dev-workflow/artifacts/documentation/` and nowhere else, which is inside
 * the payload root it already owns, and which the installer's delete pass never
 * touches because the files are not in its manifest.
 *
 * The judgement is the model's and the bookkeeping is this file's: reading a
 * document and deciding what it claims cannot be done by a script, and keeping
 * an append-only ledger honest across a dozen sessions should not be done by a
 * model. That split is the whole design.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

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
} from '../../lib/ingest.mjs';
import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, readArg, refuseMissingAnchors, resolveRepo, UserError } from './common.mjs';

/** Everything this command writes lives here, and nothing of ours lives outside it. */
export const ARTIFACT_DIR = join('_dev-workflow', 'artifacts', 'documentation');
const LEDGER = 'ledger.json';
const MAP = 'map.md';

const USAGE = `usage: dev.mjs ingest <verb>

  (no verb)              where the survey stands
  scan [--repo PATH]     inventory the documents; safe to re-run
  next [--all]           the single next unit of work; --all lists every pending document
  read <path>            mark one document read
  record <@file>         add claims and questions, as JSON
  answer <id> <text>     settle one open question
  emit                   regenerate the map from the ledger`;

const paths = (root) => ({
  dir: join(root, ARTIFACT_DIR),
  ledger: join(root, ARTIFACT_DIR, LEDGER),
  map: join(root, ARTIFACT_DIR, MAP),
});

function loadLedger(root) {
  const { ledger } = paths(root);
  if (!existsSync(ledger)) return null;
  try {
    return JSON.parse(readFileSync(ledger, 'utf8'));
  } catch (err) {
    throw new UserError(
      `${ledger} is not readable JSON: ${err.message}\n` +
        'It is the record of everything already decided — repair it by hand rather than deleting it.',
    );
  }
}

function saveLedger(root, ledger) {
  const p = paths(root);
  mkdirSync(dirname(p.ledger), { recursive: true });
  writeFileSync(p.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** The ledger, or a message naming the command that would create one. */
function requireLedger(root) {
  const ledger = loadLedger(root);
  if (!ledger) throw new UserError('no survey has been started here — run: dev.mjs ingest scan');
  return ledger;
}

export async function run(argv) {
  const [verb, ...rest] = argv;
  const { config, root } = await context();

  if (!verb || verb === 'status') {
    const ledger = requireLedger(root);
    process.stdout.write(`${describeLedger(ledger).join('\n')}\n`);
    return 0;
  }

  if (verb === 'scan') return scan({ config, root, rest });

  if (verb === 'next') {
    const all = rest.includes('--all');
    const ledger = requireLedger(root);
    const unit = nextUnit(ledger);
    const L = [`[${unit.phase}] ${unit.what}`];

    if (unit.detail?.path) {
      if (all) {
        // Every pending path, not just the next one — for a caller handing a
        // whole batch to parallel readers rather than reading them here.
        L.push('', `  pending (${unit.detail.pending.length}):`, ...unit.detail.pending.map((p) => `    ${p}`));
      } else {
        const after = unit.detail.remaining - 1;
        L.push(
          '',
          `  read:  ${unit.detail.path}`,
          `  left:  ${after} document(s) after this one`,
        );
      }
    }
    if (unit.detail?.questions) {
      L.push('');
      for (const q of unit.detail.questions) {
        L.push(`  ${q.id}  ${q.text}`);
        for (const option of q.options) L.push(`        - ${option}`);
        L.push(`        because: ${q.because.join(', ')}`);
      }
    }
    if (unit.detail?.claims) {
      L.push('');
      for (const c of unit.detail.claims) L.push(`  ${c.id}  ${c.text}   (${c.source})`);
    }
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  if (verb === 'read') {
    const path = rest[0];
    if (!path) throw new UserError('usage: dev.mjs ingest read <path>');

    const ledger = requireLedger(root);
    const source = ledger.sources.find((s) => s.path === path);
    if (!source) {
      throw new UserError(`${path} is not in the inventory — run "dev.mjs ingest scan", or check the path`);
    }

    saveLedger(root, {
      ...ledger,
      sources: ledger.sources.map((s) =>
        s.path === path ? { ...s, state: 'read', readAt: new Date().toISOString() } : s,
      ),
    });
    process.stdout.write(`dev ingest: ${path} marked read\n`);
    return 0;
  }

  if (verb === 'record') {
    const raw = rest[0];
    if (!raw) throw new UserError('usage: dev.mjs ingest record @claims.json');

    let payload;
    try {
      payload = JSON.parse(readArg(raw, 'claims file'));
    } catch (err) {
      throw new UserError(`the claims file is not valid JSON: ${err.message}`);
    }

    let ledger = requireLedger(root);

    // An anchor naming a file that is not there is a claim that reads as
    // checked and is not. Shared with `docs record` so the two cannot disagree
    // about what an anchor is.
    refuseMissingAnchors(payload.claims ?? [], root);

    // Claims first: a question cites claims by id, so a batch that records both
    // at once must be able to see the ids it just created.
    const withClaims = addClaims(ledger, payload.claims ?? []);
    if (!withClaims.ok) throw new UserError(withClaims.error);
    ledger = withClaims.ledger;

    const withQuestions = addQuestions(ledger, payload.questions ?? []);
    if (!withQuestions.ok) throw new UserError(withQuestions.error);
    ledger = withQuestions.ledger;

    saveLedger(root, ledger);
    process.stdout.write(
      `dev ingest: ${withClaims.added.length} claim(s), ${withQuestions.added.length} question(s) recorded\n` +
        (withClaims.added.length ? `  ${withClaims.added.map((c) => c.id).join(', ')}\n` : '') +
        (withQuestions.added.length ? `  ${withQuestions.added.map((q) => q.id).join(', ')}\n` : ''),
    );
    return 0;
  }

  if (verb === 'answer') {
    const [id, ...text] = rest;
    if (!id || !text.length) throw new UserError('usage: dev.mjs ingest answer <id> "<the decision>"');

    const ledger = requireLedger(root);
    const result = answerQuestion(ledger, id, readArg(text.join(' '), 'answer file'));
    if (!result.ok) throw new UserError(result.error);

    saveLedger(root, result.ledger);
    process.stdout.write(`dev ingest: ${id} settled\n`);
    return 0;
  }

  if (verb === 'emit') {
    const ledger = requireLedger(root);
    const p = paths(root);
    const project = config.github?.issuesRepo || config.github?.repo || config.project || null;

    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.map, renderMap(ledger, { project }));

    const open = (ledger.questions ?? []).filter((q) => q.status === 'open').length;
    process.stdout.write(
      `dev ingest: wrote ${join(ARTIFACT_DIR, MAP)}\n` +
        (open ? `dev ingest: ${open} question(s) are still open and are listed in it as unsettled\n` : ''),
    );
    return 0;
  }

  throw new UserError(`unknown verb "${verb}"\n\n${USAGE}`);
}

/**
 * Inventory the project's documents.
 *
 * Re-runnable by design: a document whose hash is unchanged keeps its read
 * state, so a second scan costs nothing, and one that changed goes back to
 * pending with its claims marked stale rather than deleted — somebody may have
 * arbitrated one of them.
 */
async function scan({ config, root, rest }) {
  const opts = { repo: '' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--repo') opts.repo = rest[++i] ?? '';
    else throw new UserError(`unknown argument '${rest[i]}'\n\n${USAGE}`);
  }

  const vcs = makeVcs({ run: sh });
  const configured = resolveRepo(config, root, opts.repo);
  const dir = await vcs.mainCheckout(configured.dir);

  const listed = await sh('git', ['-C', dir, 'ls-files']);
  if (!listed.ok) {
    throw new UserError(`could not list tracked files in ${dir}: ${listed.stderr || 'is it a git repository?'}`);
  }

  const found = [];
  for (const path of listed.stdout.split('\n').filter(Boolean)) {
    if (classifyPath(path) !== 'doc') continue;
    const abs = resolve(dir, path);
    try {
      found.push({
        path,
        sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
        bytes: statSync(abs).size,
      });
    } catch {
      // Tracked but not on disk. Skipped rather than fatal: a sparse checkout
      // is a legitimate state and the rest of the inventory is still useful.
    }
  }

  const before = loadLedger(root) ?? emptyLedger({});
  const merged = mergeSources(before, found);
  saveLedger(root, merged.ledger);

  const L = [`repo:     ${configured.path} (${dir})`, `documents: ${found.length}`];
  if (merged.added.length) L.push(`new:      ${merged.added.length}`);
  if (merged.changed.length) L.push(`changed:  ${merged.changed.join(', ')}`);
  if (merged.gone.length) L.push(`gone:     ${merged.gone.join(', ')}   (their claims are kept)`);
  L.push('', `next:     ${nextUnit(merged.ledger).what}`);

  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}
