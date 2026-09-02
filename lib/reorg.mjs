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
  if (mergeTarget && mergeTarget === path) {
    return { ok: false, error: `${path}: cannot merge into itself` };
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
    ledger: { ...ledger, verdicts: [...existing.values()].sort(byPath) },
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

// ---------------------------------------------------------------------------
// Phase 2 — which two documents say the same thing
// ---------------------------------------------------------------------------

/**
 * Default Jaccard threshold for `shortlistPairs`. The figure the original
 * specification named for cosine similarity over embeddings, carried over
 * unchanged: no corpus has been measured against it yet, and a number tuned
 * against a guess is a guess with more decimals. It is a flag, not a constant
 * anyone should reach for.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/** Verdicts whose documents are still in play for pairing. */
const IN_PLAY = ['keep', 'merge'];

const normaliseKeywords = (keywords) => new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));

/**
 * The keyword-overlap prefilter.
 *
 * Judging every pair of documents is O(n²) assistant calls, which a real
 * corpus never survives. This ranks the pairs first, in plain arithmetic, so
 * the judgement (§2's "is this a duplicate, an overlap, or a contradiction")
 * is spent only where the enrichment already says it might be needed.
 *
 * Only `keep` and `merge` documents are paired: an `archive`d or `delete`d
 * document has already been decided about, and a document with no verdict
 * has not been classified yet, which comes first. Documents with no keywords
 * cannot be scored. All three are *counted*, so a shortlist of nothing reads
 * as "nothing to compare" or "nothing enriched", never the same.
 *
 * @returns {{
 *   threshold: number,
 *   pairs: Array<{docA: string, docB: string, score: number, shared: string[], recorded: string|null}>,
 *   skipped: {noVerdict: number, notKeptOrMerged: number, noKeywords: number},
 * }}
 */
export function shortlistPairs(ledger, { threshold = DEFAULT_SIMILARITY_THRESHOLD } = {}) {
  const verdicts = new Map((ledger.verdicts ?? []).map((v) => [v.path, v.classification]));
  const skipped = { noVerdict: 0, notKeptOrMerged: 0, noKeywords: 0 };
  const docs = [];

  for (const source of [...(ledger.sources ?? [])].sort(byPath)) {
    if (source.state === 'missing') continue;
    const classification = verdicts.get(source.path);
    if (!classification) {
      skipped.noVerdict++;
      continue;
    }
    if (!IN_PLAY.includes(classification)) {
      skipped.notKeptOrMerged++;
      continue;
    }
    const keywords = normaliseKeywords(source.keywords ?? []);
    if (!keywords.size) {
      skipped.noKeywords++;
      continue;
    }
    docs.push({ path: source.path, keywords });
  }

  const recorded = new Map((ledger.pairs ?? []).map((p) => [pairKey(p.docA, p.docB), p.id]));
  const pairs = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i];
      const b = docs[j];
      const shared = [...a.keywords].filter((k) => b.keywords.has(k)).sort();
      const union = new Set([...a.keywords, ...b.keywords]).size;
      const score = shared.length / union;
      if (score < threshold) continue;
      pairs.push({ docA: a.path, docB: b.path, score, shared, recorded: recorded.get(pairKey(a.path, b.path)) ?? null });
    }
  }

  pairs.sort((x, y) => y.score - x.score || byPath({ path: x.docA }, { path: y.docA }) || byPath({ path: x.docB }, { path: y.docB }));
  return { threshold, pairs, skipped };
}

/** A pair is unordered: (a, b) and (b, a) are the same judgement. */
const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Code-unit order, for the same reason `lib/ingest.mjs` gives: committed output must not depend on locale. */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const short = (text) => (text.length <= 40 ? text : `${text.slice(0, 39)}…`);

/** `p2` before `p10`: numeric on the suffix, so the ledger reads in the order things were found. */
const byId = (a, b) => idNumber(a.id) - idNumber(b.id);
const idNumber = (id) => Number(String(id ?? '').replace(/^[a-z]+/, ''));

/** Highest numeric suffix among ids with the given prefix, or 0 — the same rule `lib/ingest.mjs` uses. */
function highestId(list, prefix) {
  let highest = 0;
  for (const item of list) {
    const n = Number(String(item.id ?? '').replace(prefix, ''));
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest;
}

/** How two documents can relate. A pair with none of these is not a finding. */
export const RELATIONS = ['duplicate', 'overlaps', 'contradicts'];

/**
 * Validate one pair — the assistant's judgement, after reading both sides,
 * that two documents duplicate, overlap or contradict each other.
 *
 * Evidence from *each* side is required, an anchor or a quote, for the reason
 * `validateClaim` requires an anchor: a relation with nothing to point at is a
 * guess in the voice of a finding, and a reader who doubts it has nowhere to
 * look.
 *
 * @returns {{ok: true, pair: object} | {ok: false, error: string}}
 */
export function validatePair(pair, { knownPaths }) {
  const docA = String(pair?.docA ?? '').trim();
  const docB = String(pair?.docB ?? '').trim();
  if (!docA || !docB) return { ok: false, error: 'a pair needs both docA and docB' };
  for (const doc of [docA, docB]) {
    if (!knownPaths.includes(doc)) {
      return { ok: false, error: `${doc} is not in the inventory — run "dev.mjs ingest scan", or check the path` };
    }
  }
  if (docA === docB) return { ok: false, error: `${docA}: a document cannot be paired with itself` };

  const label = `${docA} ↔ ${docB}`;
  const relation = pair?.relation;
  if (!RELATIONS.includes(relation)) {
    return { ok: false, error: `${label}: relation must be one of ${RELATIONS.join(', ')}` };
  }

  for (const field of ['justification', 'evidenceA', 'evidenceB']) {
    if (!String(pair?.[field] ?? '').trim()) {
      return { ok: false, error: `${label}: a pair needs ${field} — ${field === 'justification' ? 'why these two relate' : 'the anchor or quote on that side that shows it'}` };
    }
  }

  return {
    ok: true,
    pair: {
      docA,
      docB,
      relation,
      justification: String(pair.justification).trim(),
      evidenceA: String(pair.evidenceA).trim(),
      evidenceB: String(pair.evidenceB).trim(),
      status: 'open',
    },
  };
}

/**
 * Record a batch of pairs. All or nothing, like `addVerdicts`.
 *
 * A pair is keyed by its two documents, unordered, and re-recording one
 * replaces the earlier judgement — under the **same id**, because an
 * inconsistency may already cite it in `because`, and an id that changed
 * underneath a human decision would orphan the decision. New pairs get the
 * next `p<n>`.
 *
 * @returns {{ok: true, ledger: object, added: object[]} | {ok: false, error: string}}
 */
export function addPairs(ledger, incoming) {
  const knownPaths = (ledger.sources ?? []).map((s) => s.path);
  const existing = new Map((ledger.pairs ?? []).map((p) => [pairKey(p.docA, p.docB), p]));
  let next = highestId(ledger.pairs ?? [], 'p') + 1;
  const errors = [];
  const added = [];

  for (const raw of incoming ?? []) {
    const result = validatePair(raw, { knownPaths });
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    const key = pairKey(result.pair.docA, result.pair.docB);
    const id = existing.get(key)?.id ?? added.find((p) => pairKey(p.docA, p.docB) === key)?.id ?? `p${next++}`;
    added.push({ id, ...result.pair });
  }

  if (errors.length) return { ok: false, error: errors.join('\n') };

  for (const p of added) existing.set(pairKey(p.docA, p.docB), p);
  return {
    ok: true,
    ledger: { ...ledger, pairs: [...existing.values()].sort(byId) },
    added,
  };
}

/**
 * How an inconsistency can be settled. Typed, unlike a question's free-text
 * answer, because phase 3's mapping has to act on it: `prefer` names the
 * document that wins, `rewrite` says both are partly right and the merge is
 * where they get reconciled, `dismiss` says the two do not actually disagree.
 */
export const RESOLUTION_KINDS = ['prefer', 'rewrite', 'dismiss'];

/**
 * Append inconsistencies — the pairs whose contradiction evidence cannot
 * settle, put to a person.
 *
 * `because` must cite recorded pairs, for the reason `addQuestions` requires
 * claims: an inconsistency with no pair behind it is one the process invented,
 * and a survey that invents its own questions is an interview.
 *
 * @returns {{ok: true, ledger: object, added: object[]} | {ok: false, error: string}}
 */
export function addInconsistencies(ledger, incoming) {
  const pairIds = new Set((ledger.pairs ?? []).map((p) => p.id));
  const inconsistencies = [...(ledger.inconsistencies ?? [])];
  let next = highestId(inconsistencies, 'i') + 1;
  const added = [];

  for (const raw of incoming ?? []) {
    const text = String(raw?.text ?? '').trim();
    if (!text) return { ok: false, error: 'an inconsistency needs text' };
    if (raw?.because !== undefined && !Array.isArray(raw.because)) {
      return { ok: false, error: `inconsistency "${short(text)}": "because" must be an array of pair ids` };
    }
    if (raw?.options !== undefined && !Array.isArray(raw.options)) {
      return { ok: false, error: `inconsistency "${short(text)}": "options" must be an array of strings` };
    }
    const because = (raw?.because ?? []).filter(Boolean);
    if (!because.length) {
      return { ok: false, error: `inconsistency "${short(text)}" names no pairs in "because"` };
    }
    const unknown = because.filter((id) => !pairIds.has(id));
    if (unknown.length) {
      return { ok: false, error: `inconsistency "${short(text)}" cites unknown pairs: ${unknown.join(', ')}` };
    }

    added.push({
      id: `i${next}`,
      text,
      options: (raw?.options ?? []).map((o) => String(o).trim()).filter(Boolean),
      because,
      status: 'open',
      resolution: null,
      resolvedAt: null,
    });
    next++;
  }

  return { ok: true, ledger: { ...ledger, inconsistencies: [...inconsistencies, ...added] }, added };
}

/**
 * Settle one inconsistency. Never overwritten, for the reason `answerQuestion`
 * gives: what was decided and when is the record, and a changed mind is a new
 * inconsistency citing the same pairs.
 *
 * `prefer` needs a `path`, and it must be a side of one of the pairs the
 * inconsistency cites — preferring a document that was never in the
 * disagreement settles nothing.
 *
 * @returns {{ok: true, ledger: object} | {ok: false, error: string}}
 */
export function resolveInconsistency(ledger, id, resolution, { now = new Date() } = {}) {
  const inconsistency = (ledger.inconsistencies ?? []).find((i) => i.id === id);
  if (!inconsistency) return { ok: false, error: `no such inconsistency: ${id}` };
  if (inconsistency.status === 'resolved') {
    return {
      ok: false,
      error:
        `${id} was already resolved on ${inconsistency.resolvedAt?.slice(0, 10)}: ${inconsistency.resolution.kind}` +
        `${inconsistency.resolution.path ? ` ${inconsistency.resolution.path}` : ''} — "${inconsistency.resolution.note}"\n` +
        'Record a new inconsistency rather than overwriting what was decided.',
    };
  }

  const kind = resolution?.kind;
  if (!RESOLUTION_KINDS.includes(kind)) {
    return { ok: false, error: `${id}: resolution kind must be one of ${RESOLUTION_KINDS.join(', ')}` };
  }

  const note = String(resolution?.note ?? '').trim();
  if (!note) return { ok: false, error: `${id}: a resolution needs a note — the reason, in one line` };

  const path = String(resolution?.path ?? '').trim();
  if (kind === 'prefer') {
    if (!path) return { ok: false, error: `${id}: "prefer" needs the path of the document that wins` };
    const sides = new Set(
      (ledger.pairs ?? []).filter((p) => inconsistency.because.includes(p.id)).flatMap((p) => [p.docA, p.docB]),
    );
    if (!sides.has(path)) {
      return {
        ok: false,
        error: `${id}: "${path}" is not a side of ${inconsistency.because.join(', ')} — prefer one of: ${[...sides].sort().join(', ')}`,
      };
    }
  } else if (path) {
    return { ok: false, error: `${id}: a path is only meaningful on "prefer"` };
  }

  return {
    ok: true,
    ledger: {
      ...ledger,
      inconsistencies: ledger.inconsistencies.map((i) =>
        i.id === id
          ? { ...i, status: 'resolved', resolution: { kind, path: path || null, note }, resolvedAt: now.toISOString() }
          : i,
      ),
    },
  };
}

/**
 * The gate between detection and mapping.
 *
 * `ingest emit` renders past an open question, and lists it as unsettled,
 * because a map that says "this is still unsettled" is true and useful. A
 * mapping is different: it decides which document's text survives, and doing
 * that over an open inconsistency silently picks a side. So the phase-3 `map`
 * command asks this first and refuses unless every inconsistency is resolved
 * or the caller says, in so many words, to ignore them — and even then the
 * open ids are returned, so the override is visible in whatever it prints.
 *
 * @returns {{ok: true, open: string[]} | {ok: false, error: string, open: string[]}}
 */
export function mappingGate(ledger, { ignoreInconsistencies = false } = {}) {
  const open = (ledger.inconsistencies ?? []).filter((i) => i.status === 'open').map((i) => i.id);
  if (!open.length || ignoreInconsistencies) return { ok: true, open };
  return {
    ok: false,
    open,
    error:
      `${open.length} inconsistenc${open.length === 1 ? 'y is' : 'ies are'} still open: ${open.join(', ')}\n` +
      'Settle them first — dev.mjs reorg resolve <id> <prefer:<path>|rewrite|dismiss> "<note>" — ' +
      'or pass --ignore-inconsistencies to map over them, which picks a side silently for each one.',
  };
}

/** Everything `describeVerdicts` says, plus the pairs, the inconsistencies and whether mapping is blocked. */
export function describeReorg(ledger) {
  const pairs = ledger.pairs ?? [];
  const inconsistencies = ledger.inconsistencies ?? [];
  const count = (list, fn) => list.filter(fn).length;

  const L = ['verdicts:', ...describeVerdicts(ledger)];
  const byRelation = RELATIONS.map((r) => `${count(pairs, (p) => p.relation === r)} ${r}`).join(', ');
  const stale = count(pairs, (p) => p.status === 'stale');
  L.push(`pairs:    ${pairs.length} (${byRelation}${stale ? `; ${stale} stale` : ''})`);
  L.push(
    `inconsistencies: ${inconsistencies.length} (${count(inconsistencies, (i) => i.status === 'open')} open, ` +
      `${count(inconsistencies, (i) => i.status === 'resolved')} resolved)`,
  );

  const gate = mappingGate(ledger);
  if (!gate.ok) L.push('', `mapping is blocked by ${gate.open.join(', ')} — dev.mjs reorg resolve <id> …`);
  return L;
}

// ---------------------------------------------------------------------------
// Phase 3 — where each source goes
// ---------------------------------------------------------------------------

/** What an entry can do with its sources. The arity rules below are the definition. */
export const OPERATIONS = ['copy', 'merge', 'split', 'rewrite'];

const MAPPABLE = ['keep', 'merge'];

/** `targetFile` becomes a path under the staged tree, so it has to stay one. */
function validateTargetFile(raw, section) {
  const targetFile = String(raw ?? '').trim() || `${section}.md`;
  const parts = targetFile.split('/');
  if (
    targetFile.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(targetFile) ||
    targetFile.includes('\\') ||
    parts.some((p) => p === '..' || p === '.' || !p)
  ) {
    return { ok: false, error: `targetFile "${targetFile}" must be a relative path with no ".."` };
  }
  if (!targetFile.endsWith('.md')) return { ok: false, error: `targetFile "${targetFile}" must end in .md` };
  return { ok: true, targetFile };
}

/**
 * Validate one mapping entry — the assistant's judgement that these sources,
 * or these headings of them, become this heading of this target document.
 *
 * Refuses rather than guesses, at every join: the section has to exist in the
 * architecture, each source has to be a `keep` or `merge` document (an
 * archived, deleted or unclassified one has no business in the new tree), and
 * a named heading has to be one phase 1 recorded — so a typo in a heading is
 * an error here, not an empty section in the output.
 *
 * @returns {{ok: true, entry: object} | {ok: false, error: string}}
 */
export function validateMappingEntry(raw, { sections, ledger }) {
  const ids = sections.map((s) => s.id);
  const section = String(raw?.section ?? '').trim();
  if (!ids.includes(section)) {
    return { ok: false, error: `section "${section}" is not in the architecture: ${ids.join(', ')}` };
  }
  const heading = String(raw?.heading ?? '').trim();
  if (!heading) return { ok: false, error: `${section}: an entry needs a heading — the ## it renders under` };
  const label = `${section} › ${heading}`;

  const justification = String(raw?.justification ?? '').trim();
  if (!justification) return { ok: false, error: `${label}: an entry needs a justification` };

  const target = validateTargetFile(raw?.targetFile, section);
  if (!target.ok) return { ok: false, error: `${label}: ${target.error}` };

  const operation = raw?.operation;
  if (!OPERATIONS.includes(operation)) {
    return { ok: false, error: `${label}: operation must be one of ${OPERATIONS.join(', ')}` };
  }

  const verdicts = new Map((ledger.verdicts ?? []).map((v) => [v.path, v.classification]));
  const known = new Map((ledger.sources ?? []).map((s) => [s.path, s]));
  const sources = [];
  for (const rawSource of Array.isArray(raw?.sources) ? raw.sources : []) {
    const path = String(rawSource?.path ?? '').trim();
    if (!known.has(path)) return { ok: false, error: `${label}: ${path || '(empty path)'} is not in the inventory` };
    const classification = verdicts.get(path);
    if (!classification) return { ok: false, error: `${label}: ${path} is not classified yet — run: dev.mjs reorg classify` };
    if (!MAPPABLE.includes(classification)) {
      return { ok: false, error: `${label}: ${path} is classified "${classification}" and cannot be a source — only keep and merge documents are` };
    }
    const headings = (rawSource?.headings ?? []).map((h) => String(h).trim()).filter(Boolean);
    if (headings.length) {
      const recorded = known.get(path).headings ?? [];
      if (!recorded.length) {
        return { ok: false, error: `${label}: ${path} has no recorded headings to pick from — run: dev.mjs ingest enrich ${path} @file` };
      }
      const unknown = headings.filter((h) => !recorded.includes(h));
      if (unknown.length) {
        return { ok: false, error: `${label}: ${path} has no heading ${unknown.map((h) => `"${h}"`).join(', ')} — recorded: ${recorded.join(' | ')}` };
      }
    }
    sources.push({ path, headings });
  }
  if (!sources.length) return { ok: false, error: `${label}: an entry needs at least one source` };

  const text = String(raw?.text ?? '').trim();
  const withHeadings = sources.filter((s) => s.headings.length).length;
  if (operation === 'copy' && sources.length !== 1) return { ok: false, error: `${label}: copy takes exactly one source — use merge for several` };
  if (operation === 'copy' && withHeadings) return { ok: false, error: `${label}: copy takes the whole document — use split to take headings` };
  if (operation === 'split' && sources.length !== 1) return { ok: false, error: `${label}: split takes exactly one source` };
  if (operation === 'split' && !withHeadings) return { ok: false, error: `${label}: split needs the headings to take — or use copy for the whole document` };
  if (operation === 'merge' && sources.length < 2) return { ok: false, error: `${label}: merge needs two or more sources` };
  if (operation === 'rewrite' && !text) return { ok: false, error: `${label}: rewrite carries the new text — put it in "text"` };
  if (operation !== 'rewrite' && text) return { ok: false, error: `${label}: text is only meaningful on rewrite — the other operations take their content from the sources` };

  return {
    ok: true,
    entry: { section, targetFile: target.targetFile, heading, operation, sources, justification, text: text || null },
  };
}

/**
 * Replace the mapping. Not an upsert: a plan is one thing, reviewed as one
 * thing, and a re-run with a new file means the previous plan is withdrawn.
 * The architecture is stored beside it so `rewrite` renders the titles and
 * descriptions the mapping was validated against, not a file that may have
 * changed since.
 */
export function setMapping(ledger, incoming, { sections }) {
  const errors = [];
  const mapping = [];
  for (const raw of incoming ?? []) {
    const result = validateMappingEntry(raw, { sections, ledger });
    if (!result.ok) errors.push(result.error);
    else mapping.push(result.entry);
  }
  if (errors.length) return { ok: false, error: errors.join('\n') };
  if (!mapping.length) return { ok: false, error: 'the mapping is empty — nothing would be written' };
  return { ok: true, ledger: { ...ledger, architecture: sections.map((s) => ({ ...s })), mapping } };
}
