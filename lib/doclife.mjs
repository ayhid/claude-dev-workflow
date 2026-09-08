/**
 * Lifecycle triage — is a document a description of the system, or a record
 * of a moment?
 *
 * `dev-ingest-docs` reads every document as a source of claims about the
 * present. On a real brownfield corpus most of `docs/` is not that: dated
 * sprint proposals, gap analyses, validation reports, stories, epics, PRDs
 * and briefs are true records of the day they were written and say nothing
 * about what the system *is*. Read as sources, they produce confidently
 * anchored claims from year-old snapshots — the failure the anchoring rule
 * exists to prevent, arriving through the front door.
 *
 * ## Rules, not files
 *
 * Three hundred files cannot be triaged one at a time, so the unit of
 * proposal — and of approval — is a **rule**: a pattern over the path, with
 * the documents it covers counted beneath it. The user confirms or corrects
 * the rule once and the answer applies to all of them. Every proposal names
 * the rule that produced it, so nothing is ever excluded silently: a document
 * set aside can always be traced back to the one line that set it aside.
 *
 * ## What an answer becomes
 *
 * Only `historical` produces anything: an `archive` verdict per path, written
 * through `lib/reorg.mjs`'s `addVerdicts` with the rule in its justification.
 * That is deliberate — a triage answer is a relevance call about the document,
 * which is exactly what a verdict already is, and a second store recording the
 * same thing in a different shape is the drift this repo refuses everywhere.
 * `reference` is the default the reading proceeds under and needs no record;
 * `generated` is already excluded by `classifyPath` before it reaches here.
 *
 * Pure: no imports, no fs, no clock. The command owns the ledger.
 */

/** What a document can be, over time. */
export const LIFECYCLES = ['reference', 'historical', 'generated'];

const YEAR = '(19|20)\\d{2}';
const DATED = new RegExp(
  `\\d{4}-\\d{2}-\\d{2}|(^|[-_.])\\d{4}-\\d{2}([-_.]|$)|(^|[-_.])\\d{8}([-_.]|$)|(^|[-_])${YEAR}([-_]|$)`,
);

/** The same patterns `classifyPath` excludes — kept in step by hand, since this file imports nothing. */
const GENERATED = [/^changelog/, /^license/, /^code_of_conduct/, /^security\.md$/];

const hasSegment = (segments, ...names) => segments.some((s) => names.includes(s));
const stemIs = (stem, name) => stem === name || stem.startsWith(`${name}-`) || stem.startsWith(`${name}_`);

/**
 * The rules, in the order they are tried. First match wins, so the order is
 * the policy: a reference name beats a date in the same name (`README-2025`
 * is still the README), every historical pattern beats the generated ones,
 * and the default is last and matches everything.
 *
 * Each `test` sees the lowercased path, its basename, the basename without
 * extension, and the directory segments — enough to write a rule without
 * re-deriving any of it.
 */
export const RULES = [
  { id: 'readme', lifecycle: 'reference', text: 'a README describes the project as it is', test: (_p, _b, stem) => stemIs(stem, 'readme') },
  { id: 'architecture', lifecycle: 'reference', text: 'an architecture document describes the system as built', test: (_p, _b, stem, segs) => stemIs(stem, 'architecture') || hasSegment(segs, 'architecture') },
  { id: 'manual', lifecycle: 'reference', text: 'a manual or guide describes how the system is used', test: (_p, _b, stem, segs) => stemIs(stem, 'manual') || hasSegment(segs, 'manual', 'manuals') },
  { id: 'dated-name', lifecycle: 'historical', text: 'a date in the file name marks a snapshot of a moment', test: (_p, _b, stem) => DATED.test(stem) },
  { id: 'stories-dir', lifecycle: 'historical', text: 'user stories and epics record what was asked for, not what was built', test: (_p, _b, _s, segs) => hasSegment(segs, 'stories', 'story', 'user-stories', 'epics', 'epic') },
  { id: 'proposal', lifecycle: 'historical', text: 'a proposal records a change as it was argued for, before it was made', test: (p) => p.includes('proposal') },
  { id: 'analysis', lifecycle: 'historical', text: 'an analysis records findings at the time it was run', test: (p) => p.includes('analysis') || p.includes('analyses') },
  { id: 'report', lifecycle: 'historical', text: 'a report records an outcome at the time it was written', test: (p) => p.includes('report') },
  { id: 'prd', lifecycle: 'historical', text: 'a PRD records requirements as they stood before the work', test: (_p, _b, stem, segs) => hasSegment(segs, 'prd', 'prds') || stemIs(stem, 'prd') || /[-_]prd$/.test(stem) },
  { id: 'brief', lifecycle: 'historical', text: 'a brief records the framing of a piece of work, not its result', test: (p) => p.includes('brief') },
  { id: 'generated', lifecycle: 'generated', text: 'a changelog or licence is a true record and a useless source of claims', test: (_p, base) => GENERATED.some((re) => re.test(base)) },
  { id: 'default-reference', lifecycle: 'reference', text: 'nothing in the name says otherwise, so it is read as a description of the system', test: () => true },
];

const byId = new Map(RULES.map((r) => [r.id, r]));

/** The parts of a path a rule may look at. */
function partsOf(path) {
  const lower = String(path ?? '').replace(/^\.\//, '').toLowerCase();
  const segments = lower.split('/');
  const base = segments.pop();
  const dot = base.lastIndexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  return { lower, base, stem, segments };
}

/**
 * What one path is, and which rule said so.
 *
 * @returns {{lifecycle: string, rule: string}}
 */
export function proposeLifecycle(path) {
  const { lower, base, stem, segments } = partsOf(path);
  const rule = RULES.find((r) => r.test(lower, base, stem, segments));
  return { lifecycle: rule.lifecycle, rule: rule.id };
}

/** Code-unit order, so committed output never depends on locale. */
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every path grouped under the rule that claims it, in `RULES` order, paths
 * sorted — the same input always groups the same way. A rule that claims
 * nothing is left out: a triage is about what is there.
 *
 * @returns {Array<{rule: string, lifecycle: string, text: string, paths: string[]}>}
 */
export function proposeTriage(paths) {
  const grouped = new Map();
  for (const path of paths ?? []) {
    const { rule } = proposeLifecycle(path);
    if (!grouped.has(rule)) grouped.set(rule, []);
    grouped.get(rule).push(String(path));
  }
  return RULES.filter((r) => grouped.has(r.id)).map((r) => ({
    rule: r.id,
    lifecycle: r.lifecycle,
    text: r.text,
    paths: [...new Set(grouped.get(r.id))].sort(byPath),
  }));
}

/** How many paths a rule's line shows before it says "+N more". */
export const SAMPLE_PATHS = 5;

/** One line per rule with its count, then a few of its paths. */
export function renderTriage(groups) {
  const L = [];
  for (const g of groups) {
    const n = g.paths.length;
    L.push(`${g.rule.padEnd(18)} ${g.lifecycle.padEnd(11)} ${n} document${n === 1 ? '' : 's'}   ${g.text}`);
    for (const p of g.paths.slice(0, SAMPLE_PATHS)) L.push(`      ${p}`);
    if (n > SAMPLE_PATHS) L.push(`      +${n - SAMPLE_PATHS} more`);
  }
  return L;
}

/**
 * Turn confirmed answers into verdicts.
 *
 * `answers.rules` maps a rule id to the lifecycle the user confirmed for it;
 * `answers.paths` does the same for one path, and beats its rule. A rule with
 * no answer is **counted, not applied**: silence is not confirmation, and the
 * count is what tells the caller how much is still undecided. `applied` counts
 * only the paths the rule's own answer decided; the overridden ones are
 * counted once, in `overridden`, so the two never describe the same path. An unknown id,
 * an unknown lifecycle or a path outside the groups refuses the whole batch,
 * for the reason `addVerdicts` does.
 *
 * @returns {{ok: true, verdicts: object[], applied: object[], skipped: object[], overridden: number}
 *   | {ok: false, error: string}}
 */
export function applyTriage(groups, answers = {}) {
  const rules = answers.rules ?? {};
  const paths = answers.paths ?? {};
  const known = new Set(groups.flatMap((g) => g.paths));

  for (const [id, lifecycle] of Object.entries(rules)) {
    if (!byId.has(id)) return { ok: false, error: `unknown triage rule "${id}" — one of: ${RULES.map((r) => r.id).join(', ')}` };
    if (!LIFECYCLES.includes(lifecycle)) return { ok: false, error: `rule ${id}: lifecycle must be one of ${LIFECYCLES.join(', ')}, not "${lifecycle}"` };
  }
  for (const [path, lifecycle] of Object.entries(paths)) {
    if (!known.has(path)) return { ok: false, error: `${path} is not among the documents being triaged` };
    if (!LIFECYCLES.includes(lifecycle)) return { ok: false, error: `${path}: lifecycle must be one of ${LIFECYCLES.join(', ')}, not "${lifecycle}"` };
  }

  const verdicts = [];
  const applied = [];
  const skipped = [];
  let overridden = 0;

  for (const g of groups) {
    const ruleAnswer = rules[g.rule];
    // `byRule` is what the rule itself decided. An overridden path is
    // reported as an override, never under the rule's answer — a summary line
    // saying `dated-name: historical (3 documents)` when one of the three was
    // kept as reference would contradict the verdicts it describes.
    let byRule = 0;
    let unanswered = 0;
    for (const path of g.paths) {
      const override = paths[path];
      const lifecycle = override ?? ruleAnswer;
      if (override !== undefined) overridden++;
      else if (ruleAnswer !== undefined) byRule++;
      if (lifecycle === undefined) {
        unanswered++;
        continue;
      }
      if (lifecycle !== 'historical') continue;
      verdicts.push({
        path,
        classification: 'archive',
        justification: override !== undefined ? `triage path override: ${path} is a record of a moment` : `triage rule ${g.rule}: ${g.text}`,
      });
    }
    if (ruleAnswer !== undefined) applied.push({ rule: g.rule, lifecycle: ruleAnswer, count: byRule });
    if (unanswered) skipped.push({ rule: g.rule, count: unanswered });
  }

  return { ok: true, verdicts, applied, skipped, overridden };
}
