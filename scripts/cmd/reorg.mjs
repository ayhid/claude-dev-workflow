/**
 * Turn a `dev-ingest-docs` survey into a reorganisation — phase 1: relevance.
 *
 *   dev.mjs reorg                where classification stands
 *   dev.mjs reorg classify @file batch of {path, classification, justification, mergeTarget?}
 *   dev.mjs reorg shortlist      pairs of keep/merge documents whose keywords overlap
 *   dev.mjs reorg detect @file   pairs {docA, docB, relation, justification, evidenceA, evidenceB},
 *                                and the inconsistencies {text, because, options?} that cite them
 *   dev.mjs reorg resolve <id> <kind> "<note>"   settle one; kind is prefer:<path>, rewrite or dismiss
 *   dev.mjs reorg resolve @file  batch of {id, kind, path?, note}
 *
 * Reads and writes the same `_dev-workflow/artifacts/documentation/ledger.json`
 * `ingest` already owns — one project's documentation state, not two ledgers
 * answering the same question differently. `ARTIFACT_DIR` is imported from
 * `./ingest.mjs` for that reason, the same way `docs.mjs` already does.
 *
 * A ledger with no sources yet is refused, not defaulted to empty: classifying
 * a document that has never been scanned is not classifying anything.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  addInconsistencies,
  addPairs,
  addVerdicts,
  DEFAULT_SIMILARITY_THRESHOLD,
  describeVerdicts,
  resolveInconsistency,
  shortlistPairs,
} from '../../lib/reorg.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { context, readArg, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

const USAGE = `usage: dev.mjs reorg <verb>

  (no verb)          where classification stands
  classify <@file>   batch of {path, classification, justification, mergeTarget?}, as JSON
  shortlist [--similarity-threshold N]
                     pairs of keep/merge documents whose keywords overlap (Jaccard ≥ N, default ${DEFAULT_SIMILARITY_THRESHOLD})
  detect <@file>     a JSON array of pairs {docA, docB, relation, justification, evidenceA, evidenceB},
                     or {pairs: [...], inconsistencies: [{text, because: [pairId], options?}]}
  resolve <id> <kind> "<note>"
                     settle one inconsistency; kind is prefer:<path>, rewrite or dismiss
  resolve <@file>    batch of {id, kind, path?, note}, as JSON`;

const ledgerPath = (root) => join(root, ARTIFACT_DIR, LEDGER);

function loadLedger(root) {
  const path = ledgerPath(root);
  if (!existsSync(path)) return null;
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

/** A `@file` argument holding JSON, or the error that says which verb wanted one. */
function readJson(raw, verb, what) {
  if (!raw) throw new UserError(`usage: dev.mjs reorg ${verb} @${what}.json`);
  try {
    return JSON.parse(readArg(raw, `${what} file`));
  } catch (err) {
    throw new UserError(`the ${what} file is not valid JSON: ${err.message}`);
  }
}

/** A `@file` argument holding a JSON array. */
function readBatch(raw, verb, what) {
  const payload = readJson(raw, verb, what);
  if (!Array.isArray(payload)) throw new UserError(`the ${what} file must be a JSON array`);
  return payload;
}

const RESOLVE_USAGE = 'usage: dev.mjs reorg resolve <id> <prefer:<path>|rewrite|dismiss> "<note>"   or   resolve @resolutions.json';

/**
 * `resolve i3 prefer:docs/a.md "why"` or `resolve @file` — both become the
 * `{id, kind, path?, note}` records `resolveInconsistency` takes, so the
 * command line and the batch file cannot disagree about what a resolution is.
 */
function parseResolutions(rest) {
  if (rest[0]?.startsWith('@')) return readBatch(rest[0], 'resolve', 'resolutions');

  const [id, spec, ...note] = rest;
  if (!id || !spec || !note.length) throw new UserError(RESOLVE_USAGE);
  const [kind, ...pathParts] = spec.split(':');
  return [{ id, kind, path: pathParts.join(':') || undefined, note: note.join(' ') }];
}

/** The ledger, or a message naming the command that would create one. */
function requireLedger(root) {
  const ledger = loadLedger(root);
  if (!ledger) throw new UserError('no survey has been started here — run: dev.mjs ingest scan');
  return ledger;
}

export async function run(argv) {
  const [verb, ...rest] = argv;
  const { root } = await context();

  if (!verb || verb === 'status') {
    const ledger = requireLedger(root);
    process.stdout.write(`${describeVerdicts(ledger).join('\n')}\n`);
    return 0;
  }

  if (verb === 'classify') {
    const payload = readBatch(rest[0], 'classify', 'verdicts');
    const ledger = requireLedger(root);
    const result = addVerdicts(ledger, payload);
    if (!result.ok) throw new UserError(result.error);

    saveLedger(root, result.ledger);
    process.stdout.write(`dev reorg: ${result.added.length} verdict(s) recorded\n`);
    return 0;
  }

  if (verb === 'detect') {
    const payload = readJson(rest[0], 'detect', 'pairs');
    // A bare array is pairs alone; an object carries the inconsistencies that
    // cite them. Pairs first either way, the same order `ingest record` keeps
    // for claims and questions: an id has to exist before it can be cited.
    const { pairs, inconsistencies } = Array.isArray(payload) ? { pairs: payload, inconsistencies: [] } : payload;
    if (!Array.isArray(pairs ?? [])) throw new UserError('"pairs" must be a JSON array');
    if (!Array.isArray(inconsistencies ?? [])) throw new UserError('"inconsistencies" must be a JSON array');

    let ledger = requireLedger(root);
    const withPairs = addPairs(ledger, pairs ?? []);
    if (!withPairs.ok) throw new UserError(withPairs.error);
    ledger = withPairs.ledger;

    const withInconsistencies = addInconsistencies(ledger, inconsistencies ?? []);
    if (!withInconsistencies.ok) throw new UserError(withInconsistencies.error);
    ledger = withInconsistencies.ledger;

    saveLedger(root, ledger);
    const n = withInconsistencies.added.length;
    process.stdout.write(
      `dev reorg: ${withPairs.added.length} pair(s)${n ? `, ${n} inconsistenc${n === 1 ? 'y' : 'ies'}` : ''} recorded\n` +
        (withPairs.added.length ? `  ${withPairs.added.map((p) => `${p.id} ${p.docA} ${p.relation} ${p.docB}`).join('\n  ')}\n` : '') +
        (n ? `  ${withInconsistencies.added.map((i) => i.id).join(', ')}\n` : ''),
    );
    return 0;
  }

  if (verb === 'resolve') {
    const resolutions = parseResolutions(rest);

    let ledger = requireLedger(root);
    for (const r of resolutions) {
      const result = resolveInconsistency(ledger, r.id, r);
      if (!result.ok) throw new UserError(result.error);
      ledger = result.ledger;
    }

    saveLedger(root, ledger);
    process.stdout.write(`dev reorg: ${resolutions.map((r) => r.id).join(', ')} resolved\n`);
    return 0;
  }

  if (verb === 'shortlist') {
    let threshold = DEFAULT_SIMILARITY_THRESHOLD;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--similarity-threshold') {
        threshold = Number(rest[++i]);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          throw new UserError('--similarity-threshold takes a number between 0 and 1');
        }
      } else {
        throw new UserError(`unknown argument '${rest[i]}'\n\n${USAGE}`);
      }
    }

    const ledger = requireLedger(root);
    const { pairs, skipped } = shortlistPairs(ledger, { threshold });

    const L = [`threshold: ${threshold}   (Jaccard over each document's keywords)`];
    if (pairs.length) {
      L.push('', `  ${pairs.length} pair(s) to judge — duplicate, overlaps, or contradicts — then: dev.mjs reorg detect @pairs.json`, '');
      for (const p of pairs) {
        L.push(`  ${p.docA}  ${p.docB}  ${p.score.toFixed(2)}${p.recorded ? `  (recorded as ${p.recorded})` : ''}`);
        L.push(`    shared: ${p.shared.join(', ')}`);
      }
    } else {
      L.push('', '  no pair reaches the threshold — lower it with --similarity-threshold to see the nearest ones');
    }
    const skippedLines = [];
    if (skipped.noVerdict) skippedLines.push(`${skipped.noVerdict} unclassified (run: dev.mjs reorg classify)`);
    if (skipped.noKeywords) skippedLines.push(`${skipped.noKeywords} without keywords (run: dev.mjs ingest enrich)`);
    if (skipped.notKeptOrMerged) skippedLines.push(`${skipped.notKeptOrMerged} archived or deleted`);
    if (skippedLines.length) L.push('', `  not compared: ${skippedLines.join('; ')}`);

    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  throw new UserError(`unknown verb '${verb}'\n\n${USAGE}`);
}
