/**
 * Relevance classification — phase 1 of the documentation reorganisation
 * pipeline that builds on `dev-ingest-docs`'s ledger. No IO, no model calls:
 * the judgement (which of keep/merge/archive/delete a document is) is the
 * assistant's, made the same way a claim's kind and anchor are — this file
 * only refuses a malformed verdict and keeps the record of settled ones.
 *
 * ## Why a verdict, not a claim
 *
 * A verdict is about the *document*, not a fact inside it — "this file is
 * current" isn't a statement with an anchor the way "the hook is registered
 * in settings.json" is. It shares the claims/questions philosophy — refuse
 * rather than guess, require the reasoning inline — without reusing the claim
 * shape itself, since `kind`/`anchor`/`topic` don't mean anything for a
 * per-document relevance call.
 *
 * ## Upsert, not append
 *
 * Claims and questions are append-only, because a stale claim staying on the
 * record (marked `stale`, never deleted) is how a later session can tell what
 * changed. A verdict has no such history worth keeping: a document is either
 * still `keep` or it isn't, and re-classifying it (after a rescan, or because
 * the reasoning improved) should replace the old call outright. `addVerdicts`
 * therefore keys by `path` and the latest verdict for a path wins.
 */

/** What a document can be classified as. See the docblock: no fifth option. */
export const CLASSIFICATIONS = ['keep', 'merge', 'archive', 'delete'];

/**
 * Validate one verdict, naming what is missing or wrong.
 *
 * `knownPaths` is the set of documents this project actually has — a verdict
 * (or a `mergeTarget`) naming anything else is refused, the same posture
 * `ingest enrich` already takes for an unknown path.
 *
 * @returns {{ok: true, verdict: object} | {ok: false, error: string}}
 */
export function validateVerdict(verdict, { knownPaths }) {
  const path = String(verdict?.path ?? '').trim();
  if (!path) return { ok: false, error: 'a verdict needs a path' };
  if (!knownPaths.includes(path)) {
    return { ok: false, error: `${path} is not in the inventory — run "dev.mjs ingest scan", or check the path` };
  }

  const classification = verdict?.classification;
  if (!CLASSIFICATIONS.includes(classification)) {
    return {
      ok: false,
      error: `${path}: classification must be one of ${CLASSIFICATIONS.join(', ')}`,
    };
  }

  const justification = String(verdict?.justification ?? '').trim();
  if (!justification) {
    return { ok: false, error: `${path}: a verdict needs a justification, the same as a question needs its because` };
  }

  const mergeTarget = String(verdict?.mergeTarget ?? '').trim();
  if (classification === 'merge' && !mergeTarget) {
    return { ok: false, error: `${path}: classification "merge" needs a mergeTarget — which document does it merge into?` };
  }
  if (classification !== 'merge' && mergeTarget) {
    return { ok: false, error: `${path}: mergeTarget is only meaningful on classification "merge"` };
  }
  if (mergeTarget && !knownPaths.includes(mergeTarget)) {
    return { ok: false, error: `${path}: mergeTarget "${mergeTarget}" is not in the inventory` };
  }

  return {
    ok: true,
    verdict: { path, classification, justification, mergeTarget: mergeTarget || null },
  };
}

/**
 * Upsert a batch of verdicts. All or nothing: a bad verdict in the batch
 * leaves the ledger untouched, the same as a bad claim leaves `addClaims`'
 * input alone.
 *
 * @returns {{ok: true, ledger: object, added: string[]} | {ok: false, error: string}}
 */
export function addVerdicts(ledger, incoming) {
  const knownPaths = (ledger.sources ?? []).map((s) => s.path);
  const existing = new Map((ledger.verdicts ?? []).map((v) => [v.path, v]));
  const errors = [];
  const validated = [];

  for (const raw of incoming ?? []) {
    const result = validateVerdict(raw, { knownPaths });
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    validated.push(result.verdict);
  }

  if (errors.length) return { ok: false, error: errors.join('\n') };

  for (const v of validated) existing.set(v.path, v);

  return {
    ok: true,
    ledger: { ...ledger, verdicts: [...existing.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) },
    added: validated.map((v) => v.path),
  };
}

/** Progress, as lines — counts by classification, plus what has none yet. */
export function describeVerdicts(ledger) {
  const sources = ledger.sources ?? [];
  const verdicts = ledger.verdicts ?? [];
  const byPath = new Map(verdicts.map((v) => [v.path, v]));

  const L = [];
  for (const c of CLASSIFICATIONS) {
    const count = verdicts.filter((v) => v.classification === c).length;
    L.push(`  ${c}: ${count}`);
  }
  const unclassified = sources.filter((s) => !byPath.has(s.path)).length;
  if (unclassified) L.push(`  ${unclassified} unclassified`);
  return L;
}
