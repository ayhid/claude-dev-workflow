/**
 * Turn a `dev-ingest-docs` survey into a reorganisation — phase 1: relevance.
 *
 *   dev.mjs reorg                where classification stands
 *   dev.mjs reorg classify @file batch of {path, classification, justification, mergeTarget?}
 *   dev.mjs reorg shortlist      pairs of keep/merge documents whose keywords overlap
 *   dev.mjs reorg detect @file   batch of {docA, docB, relation, justification, evidenceA, evidenceB}
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

import { addPairs, addVerdicts, DEFAULT_SIMILARITY_THRESHOLD, describeVerdicts, shortlistPairs } from '../../lib/reorg.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { context, readArg, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

const USAGE = `usage: dev.mjs reorg <verb>

  (no verb)          where classification stands
  classify <@file>   batch of {path, classification, justification, mergeTarget?}, as JSON
  shortlist [--similarity-threshold N]
                     pairs of keep/merge documents whose keywords overlap (Jaccard ≥ N, default ${DEFAULT_SIMILARITY_THRESHOLD})
  detect <@file>     batch of {docA, docB, relation, justification, evidenceA, evidenceB}, as JSON`;

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

/** A `@file` argument holding a JSON array, or the error that says which verb wanted one. */
function readBatch(raw, verb, what) {
  if (!raw) throw new UserError(`usage: dev.mjs reorg ${verb} @${what}.json`);
  let payload;
  try {
    payload = JSON.parse(readArg(raw, `${what} file`));
  } catch (err) {
    throw new UserError(`the ${what} file is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(payload)) throw new UserError(`the ${what} file must be a JSON array`);
  return payload;
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
    const payload = readBatch(rest[0], 'detect', 'pairs');
    const ledger = requireLedger(root);
    const result = addPairs(ledger, payload);
    if (!result.ok) throw new UserError(result.error);

    saveLedger(root, result.ledger);
    process.stdout.write(
      `dev reorg: ${result.added.length} pair(s) recorded\n` +
        (result.added.length ? `  ${result.added.map((p) => `${p.id} ${p.docA} ${p.relation} ${p.docB}`).join('\n  ')}\n` : ''),
    );
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
