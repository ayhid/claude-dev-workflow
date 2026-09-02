/**
 * The documentation ledger: claims, contradictions and the questions only a
 * human can settle. No IO.
 *
 * ## Why a claim and not a document
 *
 * "Read the codebase and write the docs" produces prose nobody can falsify.
 * Six months later no one can tell which sentences are still true, so the whole
 * artifact rots at the speed of its worst line — and a session that trusts it
 * confidently reimplements something that already exists.
 *
 * So the atom here is a **claim**: one statement, plus where it came from, plus
 * an *anchor* — the `file:line` or command that would show it to be true — plus
 * its **kind**:
 *
 *   - `observable` — checkable against the tree. "The hook is registered in
 *     .claude/settings.json." Two of these disagreeing is a contradiction that
 *     can be located, and later, re-checked.
 *   - `intent` — why something is the way it is. "Worktree mode is the default
 *     so starting a ticket never disturbs uncommitted work." No amount of
 *     reading settles a disagreement between two of these; a person has to.
 *
 * That split is the whole design. It is what makes inconsistency detection
 * mechanical for the half that can be mechanical, and what keeps arbitration
 * down to the questions that genuinely need a human — because a process that
 * asks about everything gets abandoned on the first run.
 *
 * ## What this file refuses
 *
 * An `observable` claim with no anchor is refused rather than stored. It is the
 * one rule that keeps the map worth reading: an unanchored claim is a guess in
 * the voice of a fact, and a ledger of those is worse than no ledger, because
 * it reads exactly like one that was checked.
 *
 * Pure, so the format is asserted with no filesystem, the clock is a parameter,
 * and the same ledger always renders the same bytes.
 */

/** Bumped when the on-disk shape changes in a way an older reader would misread. */
export const LEDGER_VERSION = 1;

/** What a claim can be. See the docblock: the split is load-bearing. */
export const KINDS = ['observable', 'intent'];

/** Phases, in order. `nextUnit` never skips one that still has work in it. */
export const PHASES = ['inventory', 'extract', 'arbitrate', 'emit'];

/**
 * The state of a source this tool wrote itself.
 *
 * `dev.mjs docs init` records each document it generates with the sha256 it
 * wrote, under this state. Without it the tool reads its own output back in:
 * `classifyPath('docs/architecture.md')` is `doc`, and `docs/**` is not
 * excluded from `ingest scan` the way `_dev-workflow/artifacts/**` is.
 *
 * It needs no branch in `nextUnit`, which offers only `pending` sources, and
 * none in `mergeSources`, which keeps a source's state while its hash matches
 * and resets it to `pending` when it does not. A hand-edited generated document
 * therefore lands back in the extraction queue with its claims marked stale,
 * which is exactly right: somebody wrote prose into it that the ledger has
 * never seen.
 */
export const GENERATED_STATE = 'generated';

/**
 * Files whose *content* is prose about the project, not the project itself.
 *
 * Discovery runs off `git ls-files`, so anything ignored is already excluded and
 * `node_modules` never has to be special-cased. What is left is a naming
 * question, and it is answered here rather than in the command so both `assess`
 * and `ingest scan` agree about what a document is — two lists would drift, and
 * the stage verdict would then be measured against a different corpus than the
 * one that gets read.
 *
 * Generated prose is deliberately excluded. A CHANGELOG is a true record and a
 * useless source of claims: it says what changed, never what is.
 */
const DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.adoc', '.txt'];
const DOC_NAMES = ['readme', 'contributing', 'architecture', 'design', 'decisions', 'adr', 'notes'];
const GENERATED = [/^changelog/i, /^license/i, /^code_of_conduct/i, /^security\.md$/i];

/** Files an agent already reads as instructions. Documents, and worth naming. */
export const AGENT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  'GEMINI.md',
];

const SOURCE_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.scala', '.ex', '.exs', '.erl', '.clj', '.sh',
  '.bash', '.sql', '.vue', '.svelte',
];

const extensionOf = (path) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

/**
 * What one tracked path is, for the purposes of surveying a project.
 *
 * @returns {'doc'|'source'|'other'}
 */
export function classifyPath(path) {
  const clean = String(path ?? '').replace(/^\.\//, '');
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const ext = extensionOf(clean);

  if (AGENT_FILES.includes(clean)) return 'doc';

  // Our own installed payload is not the project's documentation, and neither
  // is anything this survey has already generated. Reading our own output back
  // in would compound every mistake it ever made.
  //
  // An agent-skill payload is instructions written *for* an agent, not prose
  // *about* this codebase, so none of it answers the question this survey asks.
  // Discovery runs off `git ls-files`, so a repo that vendors third-party packs
  // hands every one of their files to the classifier — 72% of the tracked
  // corpus (2487 of 3449 files) in the checkout that surfaced this (#34).
  //
  // The rule is the directory, not the prefix. It used to be `dev-` prefixed
  // only — the boundary `isOwnedPath` draws — on the grounds that a skill the
  // user wrote is genuinely their documentation. It is not: a hand-written
  // SKILL.md is still agent instructions, and the prefix rule left every
  // vendored pack in scope while excluding only our own.
  if (clean.startsWith('_dev-workflow/')) return 'other';
  if (/^\.(claude|agents|gemini)\/skills\/[^/]+\//.test(clean)) return 'other';
  if (/^\.claude\/plugins\//.test(clean)) return 'other';

  if (GENERATED.some((re) => re.test(base))) return 'other';

  if (DOC_EXTENSIONS.includes(ext)) {
    const stem = base.slice(0, base.length - ext.length).toLowerCase();
    if (clean.includes('docs/') || clean.includes('doc/')) return 'doc';
    if (DOC_NAMES.some((n) => stem === n || stem.startsWith(`${n}-`) || stem.startsWith(`${n}_`))) return 'doc';
    // A stray .md anywhere else is still prose about the project.
    return 'doc';
  }

  if (SOURCE_EXTENSIONS.includes(ext)) return 'source';
  return 'other';
}

export function emptyLedger({ now = new Date() } = {}) {
  return {
    version: LEDGER_VERSION,
    startedAt: now.toISOString(),
    sources: [],
    claims: [],
    questions: [],
  };
}

/**
 * Merge a fresh file inventory into the ledger.
 *
 * A source whose hash still matches keeps its `read` state — that is what makes
 * a second run cheap. A source whose hash changed goes back to `pending`,
 * because the claims taken from it were taken from a different file; they are
 * kept and marked `stale` rather than deleted, since somebody may have answered
 * a question about one of them.
 *
 * @param {object} ledger
 * @param {Array<{path: string, sha256: string, bytes: number}>} found
 */
export function mergeSources(ledger, found, { now = new Date() } = {}) {
  const before = new Map((ledger.sources ?? []).map((s) => [s.path, s]));
  const sources = [];
  const changed = [];

  for (const file of found) {
    const previous = before.get(file.path);
    if (previous && previous.sha256 === file.sha256) {
      sources.push({ ...previous, bytes: file.bytes });
      continue;
    }
    if (previous) changed.push(file.path);
    sources.push({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      state: 'pending',
      readAt: null,
    });
  }

  // A source that has disappeared is not dropped silently: its claims are still
  // in the ledger and somebody may have arbitrated one.
  const gone = [...before.keys()].filter((p) => !found.some((f) => f.path === p));
  for (const path of gone) sources.push({ ...before.get(path), state: 'missing' });

  const claims = (ledger.claims ?? []).map((c) =>
    changed.includes(c.source) ? { ...c, status: 'stale', staleSince: now.toISOString() } : c,
  );

  // A relevance verdict (see lib/reorg.mjs) is a call about content that has
  // just changed underneath it — dropped, not marked stale, since there is no
  // partial-truth reading of "this document is still worth keeping" the way a
  // claim can be half-right. describeVerdicts then correctly reports it as
  // unclassified again rather than counting a verdict about a document that no
  // longer exists.
  const verdicts = (ledger.verdicts ?? []).filter((v) => !changed.includes(v.path));

  return {
    ledger: { ...ledger, sources: sources.sort(byPath), claims, verdicts },
    changed,
    gone,
    added: found.filter((f) => !before.has(f.path)).map((f) => f.path),
  };
}

/** Fields `validateEnrichment` recognises, and nothing else. */
const ENRICHMENT_FIELDS = ['summary', 'keywords', 'headings', 'frontmatter', 'wordCount'];

/**
 * Validate a batch of per-document enrichment — the summary, keywords, headings,
 * frontmatter and word count a subagent reads off a document while it is
 * already extracting claims from it, one pass instead of two.
 *
 * Refuses rather than guesses, same as `validateClaim`: a field that is present
 * but malformed is an error naming the field, never silently dropped or coerced.
 * At least one recognised field must be present — an enrichment call naming none
 * of them is almost certainly a mistake, not an empty update.
 *
 * @returns {{ok: true, enrichment: object} | {ok: false, error: string}}
 */
export function validateEnrichment(fields) {
  const present = ENRICHMENT_FIELDS.filter((f) => fields?.[f] !== undefined);
  if (!present.length) {
    return { ok: false, error: `nothing to enrich — expected one of: ${ENRICHMENT_FIELDS.join(', ')}` };
  }

  const enrichment = {};

  if (fields.summary !== undefined) {
    if (typeof fields.summary !== 'string') return { ok: false, error: 'summary must be a string' };
    const summary = fields.summary.trim();
    if (!summary) return { ok: false, error: 'summary is present but empty' };
    enrichment.summary = summary;
  }

  if (fields.keywords !== undefined) {
    if (
      !Array.isArray(fields.keywords) ||
      !fields.keywords.length ||
      fields.keywords.some((k) => typeof k !== 'string')
    ) {
      return { ok: false, error: 'keywords must be a non-empty array of strings' };
    }
    const keywords = fields.keywords.map((k) => k.trim());
    if (keywords.some((k) => !k)) return { ok: false, error: 'keywords must not contain an empty string' };
    enrichment.keywords = keywords;
  }

  if (fields.headings !== undefined) {
    if (!Array.isArray(fields.headings) || fields.headings.some((h) => typeof h !== 'string')) {
      return { ok: false, error: 'headings must be an array of strings' };
    }
    const headings = fields.headings.map((h) => h.trim());
    if (headings.some((h) => !h)) return { ok: false, error: 'headings must not contain an empty string' };
    enrichment.headings = headings;
  }

  if (fields.frontmatter !== undefined) {
    const fm = fields.frontmatter;
    if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
      return { ok: false, error: 'frontmatter must be an object' };
    }
    enrichment.frontmatter = fm;
  }

  if (fields.wordCount !== undefined) {
    const n = fields.wordCount;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'wordCount must be a non-negative integer' };
    }
    enrichment.wordCount = n;
  }

  return { ok: true, enrichment };
}

/**
 * Merge validated enrichment onto the one source it describes.
 *
 * Applied only to the source matching `path` — refused, not silently skipped,
 * if that path is not in the inventory, the same posture `ingest read` already
 * takes. `mergeSources` carries these fields forward on an unchanged re-scan
 * (it spreads the previous source object) and drops them on a changed one for
 * free, since a changed file gets a fresh source object — stale enrichment for
 * content that no longer exists is exactly as wrong as a stale claim would be.
 *
 * @returns {{ok: true, ledger: object} | {ok: false, error: string}}
 */
export function setEnrichment(ledger, path, fields) {
  const sources = ledger.sources ?? [];
  if (!sources.some((s) => s.path === path)) {
    return { ok: false, error: `${path} is not in the inventory — run "dev.mjs ingest scan", or check the path` };
  }

  return {
    ok: true,
    ledger: {
      ...ledger,
      sources: sources.map((s) => (s.path === path ? { ...s, ...fields } : s)),
    },
  };
}

/**
 * Validate one claim, naming what is missing.
 *
 * `targets`, when given, is the set of documents a claim may be filed against —
 * `docs.set`, resolved by the caller. It is a separate field from `topic` and
 * not a reuse of it: `topic` is free-form here and is the heading a claim sits
 * under, while `target` names a document from a closed list. One field with two
 * meanings is the drift this repo refuses everywhere else.
 *
 * `recordedAt` is stamped here so a rendered document can attribute a claim
 * nobody can anchor without reading the clock at render time — a generated date
 * in the output would make `docs check` fail the day after it was written.
 *
 * @returns {{ok: true, claim: object} | {ok: false, error: string}}
 */
export function validateClaim(claim, { id, targets = null, requireTarget = false, now = new Date() } = {}) {
  const text = String(claim?.text ?? '').trim();
  if (!text) return { ok: false, error: 'a claim needs text' };

  if (!KINDS.includes(claim?.kind)) {
    return { ok: false, error: `claim "${short(text)}" needs a kind: ${KINDS.join(' or ')}` };
  }

  const anchor = String(claim.anchor ?? '').trim();
  if (claim.kind === 'observable' && !anchor) {
    return {
      ok: false,
      error:
        `observable claim "${short(text)}" has no anchor — give the file:line or the command that shows it, ` +
        'or record it as kind "intent" if only a person can know it',
    };
  }

  const source = String(claim.source ?? '').trim();
  if (claim.kind === 'intent' && !source) {
    return {
      ok: false,
      error: `intent claim "${short(text)}" has no source — say which document it came from, or "derived"`,
    };
  }

  const target = String(claim.target ?? '').trim();
  if (requireTarget && !target) {
    return {
      ok: false,
      error:
        `claim "${short(text)}" names no target — say which document it belongs in` +
        (targets ? `: ${targets.join(', ')}` : ''),
    };
  }
  if (target && targets && !targets.includes(target)) {
    return {
      ok: false,
      error: `claim "${short(text)}" targets "${target}", which is not in docs.set: ${targets.join(', ')}`,
    };
  }

  return {
    ok: true,
    claim: {
      id,
      text,
      kind: claim.kind,
      source: source || null,
      anchor: anchor || null,
      topic: String(claim.topic ?? '').trim() || null,
      target: target || null,
      status: 'open',
      recordedAt: now.toISOString(),
    },
  };
}

/**
 * Append claims, assigning stable ids. All or nothing: a batch with one bad
 * claim in it is refused whole, so a half-recorded batch can never be mistaken
 * for a complete one.
 */
export function addClaims(ledger, incoming, { targets = null, requireTarget = false, now = new Date() } = {}) {
  const claims = [...(ledger.claims ?? [])];
  let next = highestId(claims, 'c') + 1;
  const errors = [];
  const added = [];

  for (const raw of incoming ?? []) {
    const result = validateClaim(raw, { id: `c${next}`, targets, requireTarget, now });
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    added.push(result.claim);
    next++;
  }

  if (errors.length) return { ok: false, error: errors.join('\n') };
  return { ok: true, ledger: { ...ledger, claims: [...claims, ...added] }, added };
}

/**
 * Append arbitration questions.
 *
 * `because` names the claims that produced the question. It is required: a
 * question with no claims behind it is a question the process invented, and
 * answering those is how a survey turns into an interview.
 */
export function addQuestions(ledger, incoming) {
  const questions = [...(ledger.questions ?? [])];
  let next = highestId(questions, 'q') + 1;
  const added = [];

  for (const raw of incoming ?? []) {
    const text = String(raw?.text ?? '').trim();
    if (!text) return { ok: false, error: 'a question needs text' };
    const because = (raw?.because ?? []).filter(Boolean);
    if (!because.length) {
      return { ok: false, error: `question "${short(text)}" names no claims in "because"` };
    }
    const unknown = because.filter((id) => !(ledger.claims ?? []).some((c) => c.id === id));
    if (unknown.length) {
      return { ok: false, error: `question "${short(text)}" cites unknown claims: ${unknown.join(', ')}` };
    }

    added.push({
      id: `q${next}`,
      text,
      options: (raw?.options ?? []).map((o) => String(o).trim()).filter(Boolean),
      because,
      status: 'open',
      answer: null,
      answeredAt: null,
    });
    next++;
  }

  return { ok: true, ledger: { ...ledger, questions: [...questions, ...added] }, added };
}

/**
 * Record an answer. Answers are never overwritten — a settled question that
 * turns out to be wrong gets a new question, so the record of what was decided
 * and when survives.
 */
export function answerQuestion(ledger, id, answer, { now = new Date() } = {}) {
  const question = (ledger.questions ?? []).find((q) => q.id === id);
  if (!question) return { ok: false, error: `no such question: ${id}` };
  if (question.status === 'answered') {
    return {
      ok: false,
      error: `${id} was already answered on ${question.answeredAt?.slice(0, 10)}: "${question.answer}"\n` +
        'Record a new question rather than overwriting what was decided.',
    };
  }

  const text = String(answer ?? '').trim();
  if (!text) return { ok: false, error: 'an answer needs text' };

  return {
    ok: true,
    ledger: {
      ...ledger,
      questions: ledger.questions.map((q) =>
        q.id === id ? { ...q, status: 'answered', answer: text, answeredAt: now.toISOString() } : q,
      ),
    },
  };
}

/**
 * The next thing to do, and nothing about what comes after it.
 *
 * One unit at a time is the point: this runs across sessions, and a plan that
 * hands back twelve steps is a plan that gets half-done and then re-derived
 * differently by the next session.
 *
 * `detail.pending`, for the extract phase, is the one exception — not a second
 * unit of work, but the same `unread` list this function already computes to
 * pick `unread[0]`, exposed so a caller that wants to hand several documents to
 * parallel readers at once can, without re-deriving the pending set by hand or
 * racing repeated calls to this function against each other.
 *
 * @returns {{phase: string, what: string, detail?: object}}
 */
export function nextUnit(ledger) {
  const sources = ledger.sources ?? [];
  if (!sources.length) {
    return { phase: 'inventory', what: 'nothing has been inventoried yet — run: dev.mjs ingest scan' };
  }

  const unread = sources.filter((s) => s.state === 'pending').sort(byPath);
  if (unread.length) {
    return {
      phase: 'extract',
      what: `read ${unread[0].path} and record what it claims`,
      detail: { path: unread[0].path, remaining: unread.length, pending: unread.map((s) => s.path) },
    };
  }

  const open = (ledger.questions ?? []).filter((q) => q.status === 'open');
  if (open.length) {
    return {
      phase: 'arbitrate',
      what: `${open.length} question${open.length === 1 ? '' : 's'} need answering`,
      detail: { questions: open },
    };
  }

  const stale = (ledger.claims ?? []).filter((c) => c.status === 'stale');
  if (stale.length) {
    return {
      phase: 'extract',
      what: `${stale.length} claim${stale.length === 1 ? '' : 's'} came from documents that have changed since`,
      detail: { claims: stale },
    };
  }

  return { phase: 'emit', what: 'everything is read and settled — run: dev.mjs ingest emit' };
}

/** Progress, as lines. Counts only; the detail is what `next` is for. */
export function describeLedger(ledger) {
  const sources = ledger.sources ?? [];
  const claims = ledger.claims ?? [];
  const questions = ledger.questions ?? [];
  const count = (list, fn) => list.filter(fn).length;

  const L = [];
  L.push(`started:  ${ledger.startedAt?.slice(0, 10) ?? '-'}`);
  L.push(
    `sources:  ${sources.length} (${count(sources, (s) => s.state === 'read')} read, ` +
      `${count(sources, (s) => s.state === 'pending')} pending, ` +
      `${count(sources, (s) => s.state === GENERATED_STATE)} generated, ` +
      `${count(sources, (s) => s.state === 'missing')} gone)`,
  );
  L.push(
    `claims:   ${claims.length} (${count(claims, (c) => c.kind === 'observable')} observable, ` +
      `${count(claims, (c) => c.kind === 'intent')} intent, ` +
      `${count(claims, (c) => c.status === 'stale')} stale)`,
  );
  L.push(
    `questions:${questions.length} (${count(questions, (q) => q.status === 'open')} open, ` +
      `${count(questions, (q) => q.status === 'answered')} answered)`,
  );

  const next = nextUnit(ledger);
  L.push('', `next:     [${next.phase}] ${next.what}`);
  return L;
}

/**
 * The map, rendered from the ledger.
 *
 * Generated, so it is regenerated rather than edited — and it says so at the
 * top, because a generated file that does not announce itself is one somebody
 * will hand-edit and lose.
 *
 * Claims are grouped by topic and sorted within it, so the same ledger always
 * produces the same bytes and a regeneration diffs as the change it actually was.
 */
export function renderMap(ledger, { now = new Date(), project = null } = {}) {
  const claims = (ledger.claims ?? []).filter((c) => c.status !== 'stale');
  const L = [];

  L.push(`# ${project ? `${project} — ` : ''}what this codebase is`);
  L.push('');
  L.push(`Generated by \`dev.mjs ingest emit\` on ${now.toISOString().slice(0, 10)}. **Do not edit.**`);
  L.push('Change a claim by re-reading its source and re-recording it; the ledger beside this file is the record.');
  L.push('');

  const byTopic = new Map();
  for (const claim of claims) {
    const topic = claim.topic ?? 'uncategorised';
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(claim);
  }

  for (const topic of [...byTopic.keys()].sort()) {
    L.push(`## ${topic}`, '');
    for (const claim of byTopic.get(topic).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
      // The anchor is the point. A reader who doubts a line must be one click
      // from what would settle it.
      const evidence = claim.anchor ? ` — \`${claim.anchor}\`` : '';
      const from = claim.source && claim.source !== 'derived' ? ` _(${claim.source})_` : '';
      L.push(`- ${claim.text}${evidence}${from}`);
    }
    L.push('');
  }

  const answered = (ledger.questions ?? []).filter((q) => q.status === 'answered');
  if (answered.length) {
    L.push('## Decisions', '');
    L.push('Questions the documents could not settle, and what was decided.', '');
    for (const q of answered) {
      L.push(`- **${q.text}**`);
      L.push(`  ${q.answer} _(${q.answeredAt?.slice(0, 10)})_`);
    }
    L.push('');
  }

  const open = (ledger.questions ?? []).filter((q) => q.status === 'open');
  if (open.length) {
    // Printed, not hidden: a map that quietly omits what is still unsettled
    // reads as complete, which is the one thing it must never do.
    L.push('## Still unsettled', '');
    for (const q of open) L.push(`- ${q.text}  \`${q.id}\``);
    L.push('');
  }

  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * Code-unit order, not `localeCompare`.
 *
 * The ledger and the map are committed, so two developers must produce
 * byte-identical output from the same inputs. `localeCompare` with no explicit
 * locale sorts by the runtime's default one — under `en` it puts `docs/` before
 * `README.md`, under `C` the reverse — which would show up as a spurious diff
 * every time a different machine regenerated the artifact.
 */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const short = (text) => (text.length <= 40 ? text : `${text.slice(0, 39)}…`);

/** Highest numeric suffix among ids with the given prefix, or 0. */
function highestId(list, prefix) {
  let highest = 0;
  for (const item of list) {
    const n = Number(String(item.id ?? '').replace(prefix, ''));
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest;
}
