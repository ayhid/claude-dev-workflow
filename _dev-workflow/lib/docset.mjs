/**
 * The documentation skeleton: which documents a project is meant to have, and
 * how one is rendered from the claims recorded against it.
 *
 * ## Why the set lives here and nowhere else
 *
 * The target set was written down twice before this file existed — once in the
 * issue that promised the skeleton, once in the issue that promised the
 * lifecycle around it — and the two copies had already disagreed about a name
 * (*runbook* against *operations (runbook)*) before either was implemented.
 * That is the drift this repo refuses everywhere else, which is why the
 * manifest has one writer and `branch.types` maps onto `commit.types` rather
 * than restating them. So the names, the filenames and the purposes are one
 * list, here, and `lib/config.mjs` imports its default from it rather than
 * spelling it again.
 *
 * ## Why `security-model.md` and not `security.md`
 *
 * `lib/ingest.mjs:63` excludes `/^security\.md$/i` from what counts as a
 * document, and tests it against the **basename**, before the `docs/` rule. The
 * exclusion was written for a root-level GitHub `SECURITY.md` policy file, but
 * as written it also swallows a real security document under `docs/`:
 * `classifyPath('docs/security.md')` is `other`, while
 * `classifyPath('docs/security-model.md')` is `doc`. A skeleton emitting the
 * first name would produce a file `ingest scan` never inventories.
 *
 * Narrowing that regex is a separate question — it changes what `ingest scan`
 * finds in every already-surveyed project — so the filename sidesteps it and
 * the reason is written down here, in `docs/configuration.md`, and pinned by a
 * test that renames it back to `security.md` and fails.
 *
 * ## Why the renderer has no free-prose slot
 *
 * "Read the repo and write the docs" produces prose nobody can falsify, and six
 * months later no one can tell which sentences are still true. `lib/ingest.mjs`
 * answered that for *reading* — the claim, with its anchor, is the atom — and
 * this is the same answer pointed the other way: ingest turns documents into
 * claims, `docs render` turns claims into documents. `renderDocument` takes
 * claims and emits bullets. There is no parameter a paragraph could be passed
 * through, so an unfalsifiable sentence is not discouraged, it is
 * unrepresentable.
 *
 * `lib/adr.mjs`'s renderer *does* have free prose, and that is not an
 * inconsistency: an ADR is dated, immutable, and never claims to describe the
 * present, so it cannot rot the way `architecture.md` rots. A document
 * asserting how the system is *now* must carry, per sentence, the thing that
 * would show it false.
 *
 * Pure: no fs, no argv, no clock. Dates in the output come from the ledger, so
 * the same ledger renders the same bytes a month later and `docs check` still
 * passes.
 */

/**
 * The set, defined once.
 *
 * `decisions` is a **pointer**, not a file this writes: decision records are
 * `lib/adr.mjs`'s job, numbered and frozen, and a second writer for them would
 * be exactly the duplication this file exists to prevent. It is in the
 * catalogue so the set is complete — a skeleton that silently omits decisions
 * reads as though a project needs none.
 */
export const DOC_CATALOGUE = [
  {
    key: 'architecture',
    file: 'architecture.md',
    title: 'Architecture',
    purpose: 'The components, the boundaries between them, and how data moves across them.',
    writable: true,
  },
  {
    key: 'domain',
    file: 'domain.md',
    title: 'Domain',
    purpose: 'The glossary: the terms this project uses, and what each one means here.',
    writable: true,
  },
  {
    key: 'operations',
    file: 'operations.md',
    title: 'Operations',
    purpose: 'The runbook: how to run it, how to deploy it, and what breaks.',
    writable: true,
  },
  {
    key: 'testing',
    file: 'testing.md',
    title: 'Testing',
    purpose: 'What is tested, how to run the tests, and what is deliberately not tested.',
    writable: true,
  },
  {
    key: 'security',
    file: 'security-model.md',
    title: 'Security model',
    purpose: 'Trust boundaries, where secrets live, and what is assumed rather than enforced.',
    writable: true,
  },
  {
    key: 'decisions',
    file: null,
    title: 'Decisions',
    purpose: 'Which alternatives were rejected and why — one frozen record per decision.',
    writable: false,
    /** What to run instead. `docs init` prints this and writes nothing. */
    pointer: 'dev.mjs adr new "<title>"   (or the /dev-adr skill)',
  },
];

/** Every key in the catalogue, in catalogue order. */
export const DOC_KEYS = DOC_CATALOGUE.map((d) => d.key);

/**
 * The default `docs.set`, and the reason it is an array.
 *
 * `deepMerge` (`lib/config.mjs`) merges objects recursively and replaces arrays
 * outright — its own docblock says so, about `commit.types`. As an object, a
 * project listing three targets would silently get those three plus the five
 * defaults. As an array, three means three.
 */
export const DEFAULT_DOC_SET = DOC_CATALOGUE.filter((d) => d.writable).map((d) => d.key);

const entryFor = (key) => DOC_CATALOGUE.find((d) => d.key === key) ?? null;

/**
 * Resolve the configured set into documents with paths.
 *
 * @param {object} config the effective config
 * @returns {{ok: true, documents: Array<object>} | {ok: false, error: string}}
 */
export function resolveDocSet(config = {}) {
  const docs = config.docs ?? {};
  const dir = String(docs.dir ?? 'docs').replace(/\/+$/, '');
  const decisionsDir = String(docs.decisionsDir ?? 'docs/decisions').replace(/\/+$/, '');

  const wanted = docs.set ?? DEFAULT_DOC_SET;
  if (!Array.isArray(wanted)) {
    return {
      ok: false,
      error:
        'docs.set must be an array of document keys — an object would be merged into the ' +
        `defaults rather than replacing them. Known keys: ${DOC_KEYS.join(', ')}`,
    };
  }

  const documents = [];
  for (const raw of wanted) {
    const key = String(raw ?? '').trim();
    const entry = entryFor(key);
    if (!entry) {
      return { ok: false, error: `docs.set names an unknown document "${key}" — known keys: ${DOC_KEYS.join(', ')}` };
    }
    if (documents.some((d) => d.key === key)) continue;
    documents.push({
      key: entry.key,
      title: entry.title,
      purpose: entry.purpose,
      writable: entry.writable,
      pointer: entry.pointer ?? null,
      path: entry.writable ? `${dir}/${entry.file}` : decisionsDir,
    });
  }

  // The pointers come along whatever `docs.set` says. `docs.set` governs which
  // documents get *written*, and a pointer writes nothing — leaving it out
  // would make a skeleton that silently never mentions decision records, which
  // reads as though a project needs none.
  for (const entry of DOC_CATALOGUE) {
    if (entry.writable || documents.some((d) => d.key === entry.key)) continue;
    documents.push({
      key: entry.key,
      title: entry.title,
      purpose: entry.purpose,
      writable: false,
      pointer: entry.pointer ?? null,
      path: decisionsDir,
    });
  }

  return { ok: true, documents };
}

/** Every path the catalogue can produce under `config`, writable or not. */
export function docSetPaths(config = {}) {
  const all = resolveDocSet({ ...config, docs: { ...(config.docs ?? {}), set: DOC_KEYS } });
  return all.ok ? all.documents.map((d) => d.path) : [];
}

/**
 * The line a generated document carries when nothing has been recorded for it.
 *
 * A marker rather than a heuristic: `docs check` has to be able to say "this is
 * still a stub" without guessing from length or wording, and a document that
 * quietly counts as finished the moment it exists would make the check
 * meaningless.
 */
export const PLACEHOLDER_MARKER = '<!-- docs: nothing recorded yet -->';

/** Does this text still hold the stub marker `docs init` wrote? */
export function isPlaceholder(text) {
  return String(text ?? '').includes(PLACEHOLDER_MARKER);
}

/**
 * One document, rendered from claims.
 *
 * There is deliberately no parameter for prose. Every body line is a claim
 * carrying either its anchor — the thing that would show it false — or the
 * attribution of whoever asserted it.
 *
 * @param {object} doc              a resolved catalogue entry
 * @param {object} [opts]
 * @param {Array<object>} [opts.claims]     claims targeting this document
 * @param {Array<object>} [opts.unsettled]  open questions touching it
 */
export function renderDocument(doc, { claims = [], unsettled = [] } = {}) {
  const live = claims.filter((c) => c.status !== 'stale');
  const L = [];

  L.push(`# ${doc.title}`);
  L.push('');
  L.push(doc.purpose);
  L.push('');
  L.push('Generated by `dev.mjs docs render` from the claim ledger. **Do not edit.**');
  L.push('Every line below is one recorded claim; change one by re-recording it, then re-render.');
  L.push('');

  const byTopic = new Map();
  for (const claim of live) {
    const topic = claim.topic ?? 'uncategorised';
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(claim);
  }

  for (const topic of [...byTopic.keys()].sort()) {
    L.push(`## ${topic}`, '');
    for (const claim of byTopic.get(topic).sort(byId)) L.push(`- ${renderClaim(claim)}`);
    L.push('');
  }

  // Printed always, never hidden. A generated document that omits its gaps
  // reads as complete, which is the one thing it must never do — the rule
  // `renderMap`'s "Still unsettled" already holds.
  L.push('## Not yet established', '');
  if (!live.length) {
    L.push(PLACEHOLDER_MARKER);
    L.push('');
    L.push('Nothing has been recorded for this document yet.');
    L.push('Record what is true and what would show it false:');
    L.push('');
    L.push('```bash');
    L.push('dev.mjs docs record @claims.json');
    L.push(`dev.mjs docs render ${doc.key}`);
    L.push('```');
  } else if (unsettled.length) {
    for (const q of unsettled) L.push(`- ${q.text}  \`${q.id}\``);
  } else {
    L.push('Nothing outstanding was recorded against this document.');
  }
  L.push('');

  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * One claim, as a line that carries its own evidence.
 *
 * An `observable` claim shows its anchor. An `intent` claim cannot have one —
 * only a person knows why — so it shows who said it and when, from the ledger's
 * `recordedAt`. Never from the clock: a generated date would make `docs check`
 * fail the day after the document was written.
 */
function renderClaim(claim) {
  const text = String(claim.text ?? '').trim();
  if (claim.anchor) return `${text} — \`${claim.anchor}\``;

  const source = claim.source && claim.source !== 'derived' ? claim.source : 'derived';
  const on = claim.recordedAt ? `, ${String(claim.recordedAt).slice(0, 10)}` : '';
  return `${text} _(${source}${on})_`;
}

const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
