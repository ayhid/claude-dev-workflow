/**
 * Turn a `dev-ingest-docs` survey into a reorganisation — phase 1: relevance.
 *
 *   dev.mjs reorg                where classification stands
 *   dev.mjs reorg classify @file batch of {path, classification, justification, mergeTarget?}
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

import { addVerdicts, describeVerdicts } from '../../lib/reorg.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { context, readArg, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

const USAGE = `usage: dev.mjs reorg <verb>

  (no verb)          where classification stands
  classify <@file>   batch of {path, classification, justification, mergeTarget?}, as JSON`;

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
    const raw = rest[0];
    if (!raw) throw new UserError('usage: dev.mjs reorg classify @verdicts.json');

    let payload;
    try {
      payload = JSON.parse(readArg(raw, 'verdicts file'));
    } catch (err) {
      throw new UserError(`the verdicts file is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(payload)) throw new UserError('the verdicts file must be a JSON array');

    const ledger = requireLedger(root);
    const result = addVerdicts(ledger, payload);
    if (!result.ok) throw new UserError(result.error);

    saveLedger(root, result.ledger);
    process.stdout.write(`dev reorg: ${result.added.length} verdict(s) recorded\n`);
    return 0;
  }

  throw new UserError(`unknown verb '${verb}'\n\n${USAGE}`);
}
