/**
 * Turn a `dev-ingest-docs` survey into a reorganisation — phase 1: relevance.
 *
 *   dev.mjs reorg                where classification, detection and the gate stand
 *   dev.mjs reorg classify @file batch of {path, classification, justification, mergeTarget?}
 *   dev.mjs reorg shortlist      pairs of keep/merge documents whose keywords overlap
 *   dev.mjs reorg detect @file   pairs {docA, docB, relation, justification, evidenceA, evidenceB},
 *                                and the inconsistencies {text, because, options?} that cite them
 *   dev.mjs reorg resolve <id> <kind> "<note>"   settle one; kind is prefer:<path>, rewrite or dismiss
 *   dev.mjs reorg resolve @file  batch of {id, kind, path?, note}
 *   dev.mjs reorg map --architecture <file> @file [--ignore-inconsistencies]
 *                                the mapping onto the target set; writes migration-plan.md
 *   dev.mjs reorg rewrite [--dry-run] [--force] [--ignore-inconsistencies] [--repo PATH]
 *                                assemble docs-reorganized/ and migration-report.md
 *
 * Phase 3 writes under `_dev-workflow/artifacts/reorg/` — beside the ledger's
 * directory, inside the payload root, so the installer's delete pass never
 * plans it and `ingest scan` never reads it back in. Never the project's own
 * docs: applying the staged tree is separate work the user approves per file.
 *
 * Reads and writes the same `_dev-workflow/artifacts/documentation/ledger.json`
 * `ingest` already owns — one project's documentation state, not two ledgers
 * answering the same question differently. `ARTIFACT_DIR` is imported from
 * `./ingest.mjs` for that reason, the same way `docs.mjs` already does.
 *
 * A ledger with no sources yet is refused, not defaulted to empty: classifying
 * a document that has never been scanned is not classifying anything.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { extname } from 'node:path';

import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { parseArchitecture } from '../../lib/architecture.mjs';
import {
  addInconsistencies,
  addPairs,
  addVerdicts,
  DEFAULT_SIMILARITY_THRESHOLD,
  describeReorg,
  mappingGate,
  renderMigrationPlan,
  renderMigrationReport,
  renderRewrittenDoc,
  resolveInconsistency,
  setMapping,
  shortlistPairs,
} from '../../lib/reorg.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { context, readArg, resolveRepo, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

/** Everything phase 3 writes lives here, and nothing of it lives anywhere else. */
export const REORG_DIR = join('_dev-workflow', 'artifacts', 'reorg');
const PLAN = 'migration-plan.md';
const REPORT = 'migration-report.md';
const STAGED = 'docs-reorganized';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const label = (word) => `${word}:`.padEnd(15);

const USAGE = `usage: dev.mjs reorg <verb>

  (no verb)          where classification, detection and the gate stand
  classify <@file>   batch of {path, classification, justification, mergeTarget?}, as JSON
  shortlist [--similarity-threshold N]
                     pairs of keep/merge documents whose keywords overlap (Jaccard ≥ N, default ${DEFAULT_SIMILARITY_THRESHOLD})
  detect <@file>     a JSON array of pairs {docA, docB, relation, justification, evidenceA, evidenceB},
                     or {pairs: [...], inconsistencies: [{text, because: [pairId], options?}]}
  resolve <id> <kind> "<note>"
                     settle one inconsistency; kind is prefer:<path>, rewrite or dismiss
  resolve <@file>    batch of {id, kind, path?, note}, as JSON
  map --architecture <file> <@file> [--ignore-inconsistencies]
                     record the mapping onto the target set and write migration-plan.md
  rewrite [--dry-run] [--force] [--ignore-inconsistencies] [--repo PATH]
                     assemble the staged tree under docs-reorganized/ and write migration-report.md`;

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
  const { config, root } = await context();

  if (!verb || verb === 'status') {
    const ledger = requireLedger(root);
    process.stdout.write(`${describeReorg(ledger).join('\n')}\n`);
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
    if (typeof payload !== 'object' || payload === null) {
      throw new UserError('the pairs file must be a JSON array of pairs, or an object with "pairs" and "inconsistencies"');
    }
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

  if (verb === 'map') {
    const opts = { architecture: '', mapping: '', ignore: false };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--architecture') opts.architecture = rest[++i] ?? '';
      else if (rest[i] === '--ignore-inconsistencies') opts.ignore = true;
      else if (rest[i].startsWith('@')) opts.mapping = rest[i];
      else throw new UserError(`unknown argument '${rest[i]}'\n\n${USAGE}`);
    }
    if (!opts.architecture || !opts.mapping) {
      throw new UserError('usage: dev.mjs reorg map --architecture <file.json|file.yaml> @mapping.json [--ignore-inconsistencies]');
    }

    const ledger = requireLedger(root);

    // The gate, before anything is read or written: a mapping over an open
    // inconsistency picks a side silently, which is the one thing the whole
    // pipeline exists to avoid. Overriding it is allowed, and is printed.
    const gate = mappingGate(ledger, { ignoreInconsistencies: opts.ignore });
    if (!gate.ok) throw new UserError(gate.error);

    const sections = readArchitecture(opts.architecture);
    const entries = readBatch(opts.mapping, 'map', 'mapping');
    const result = setMapping(ledger, entries, { sections });
    if (!result.ok) throw new UserError(result.error);

    saveLedger(root, result.ledger);
    const planPath = join(root, REORG_DIR, PLAN);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, renderMigrationPlan(result.ledger, { ignored: gate.open }));

    const L = [`dev reorg: ${result.ledger.mapping.length} mapping entr${result.ledger.mapping.length === 1 ? 'y' : 'ies'} recorded`];
    if (gate.open.length) L.push(`dev reorg: ignored ${gate.open.length} open inconsistenc${gate.open.length === 1 ? 'y' : 'ies'}: ${gate.open.join(', ')}`);
    L.push(`dev reorg: wrote ${join(REORG_DIR, PLAN)} — review it, then: dev.mjs reorg rewrite --dry-run`);
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  if (verb === 'rewrite') {
    const opts = { dryRun: false, force: false, ignore: false, repo: '' };
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--dry-run') opts.dryRun = true;
      else if (arg === '--force') opts.force = true;
      else if (arg === '--ignore-inconsistencies') opts.ignore = true;
      else if (arg === '--repo') opts.repo = rest[++i] ?? '';
      else throw new UserError(`unknown argument '${arg}'\n\n${USAGE}`);
    }

    const ledger = requireLedger(root);
    if (!ledger.mapping?.length) {
      throw new UserError('nothing is mapped yet — run: dev.mjs reorg map --architecture <file> @mapping.json');
    }
    // Re-checked here, not only at `map`: an inconsistency raised after the
    // plan was made is still a side picked silently if the tree is written.
    const gate = mappingGate(ledger, { ignoreInconsistencies: opts.ignore });
    if (!gate.ok) throw new UserError(gate.error);

    // Sources are read from the checkout `ingest scan` inventoried — the
    // same `--repo` selection, since the ledger does not record which one.
    const vcs = makeVcs({ run: sh });
    const dir = await vcs.mainCheckout(resolveRepo(config, root, opts.repo).dir);
    const sourceText = (path) => readFileSync(resolve(dir, path), 'utf8');

    const sections = new Map((ledger.architecture ?? []).map((s) => [s.id, s]));
    const byTarget = new Map();
    for (const e of ledger.mapping) {
      if (!byTarget.has(e.targetFile)) byTarget.set(e.targetFile, []);
      byTarget.get(e.targetFile).push(e);
    }

    const rewritten = { ...(ledger.rewritten ?? {}) };
    const written = [];
    const L = [];
    let refused = 0;
    let wrote = false;

    for (const file of [...byTarget.keys()].sort()) {
      const entries = byTarget.get(file);
      const rel = join(REORG_DIR, STAGED, file);
      const abs = join(root, rel);
      let text;
      try {
        text = renderRewrittenDoc({ file, section: sections.get(entries[0].section) }, entries, { sourceText });
      } catch (err) {
        throw new UserError(`${file}: ${err.message}`);
      }
      const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;

      // Already what we would write: nothing to lose, whatever the ledger
      // remembers — so the hash is (re)recorded rather than the file refused.
      if (before === text) {
        if (rewritten[file] !== sha256(text)) {
          rewritten[file] = sha256(text);
          wrote = true;
        }
        L.push(`${label('unchanged')}${rel}`);
        written.push({ file, status: 'unchanged' });
        continue;
      }
      // A file we wrote and somebody edited since is not ours to overwrite
      // — the same rule `docs render` keeps. `--force` is the user saying
      // the edit is theirs to lose.
      if (before !== null && sha256(before) !== rewritten[file] && !opts.force) {
        L.push(`${label('refused')}${rel}   (edited by hand since it was written, or never written by this tool)`);
        written.push({ file, status: 'refused — edited by hand' });
        refused++;
        continue;
      }
      const status = before === null ? 'created' : 'rewritten';
      if (opts.dryRun) {
        L.push(`${label(`would ${status === 'created' ? 'create' : 'rewrite'}`)}${rel}`);
        written.push({ file, status: `would be ${status}` });
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      rewritten[file] = sha256(text);
      wrote = true;
      L.push(`${label(status)}${rel}`);
      written.push({ file, status });
    }

    if (!opts.dryRun) {
      const reportPath = join(root, REORG_DIR, REPORT);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, renderMigrationReport(ledger, { written, ignored: gate.open }));
      L.push(`${label('report')}${join(REORG_DIR, REPORT)}`);
      if (wrote) saveLedger(root, { ...ledger, rewritten });
    }
    if (gate.open.length) L.push('', `ignored ${gate.open.length} open inconsistenc${gate.open.length === 1 ? 'y' : 'ies'}: ${gate.open.join(', ')}`);
    if (refused) {
      L.push('', 'A refused file keeps its edits. Move them into the mapping (a rewrite entry carries text) and run again,');
      L.push('or pass --force to overwrite what was edited.');
    }
    L.push('', `The staged tree is a draft. Applying it to the project's own documentation is separate work — /dev-task it.`);

    process.stdout.write(`${L.join('\n')}\n`);
    return refused ? 1 : 0;
  }

  throw new UserError(`unknown verb '${verb}'\n\n${USAGE}`);
}

/** The architecture file, parsed by the format its extension names. */
function readArchitecture(path) {
  const ext = extname(path).toLowerCase();
  const format = ext === '.json' ? 'json' : ext === '.yaml' || ext === '.yml' ? 'yaml' : ext.slice(1);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UserError(`could not read the architecture file ${path}: ${err.message}`);
  }
  const parsed = parseArchitecture(text, { format });
  if (!parsed.ok) throw new UserError(parsed.error);
  return parsed.sections;
}
