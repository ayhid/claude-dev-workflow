/**
 * Greenfield or brownfield, decided from signals and never from a feeling.
 *
 * The two need different first moves. A greenfield project wants configuring and
 * getting out of the way; a brownfield one has years of decisions in it, half of
 * them written down somewhere and some of those no longer true, and starting
 * work there without reading first is how a session confidently reimplements
 * something that already exists.
 *
 * Pure, and every signal carries its own reasoning, because the verdict is
 * **proposed and confirmed, never applied** (lib/provider.mjs rule 2). A wrong
 * stage would send `/dev-init` down the wrong branch with nothing downstream to
 * notice, so the tally is printed and a human settles it. The answer is then
 * config — decided once, not re-derived per session.
 */

/**
 * Thresholds, named and in one place so the verdict can be argued with.
 *
 * They are split by *role*, and the split is the whole rule. What makes a
 * project brownfield is that **there is already something here** — code, or
 * documentation describing it. History is not that: `git init` on a codebase
 * somebody has been building for years produces one commit, one author and an
 * age of zero, and a scorer that counted those as votes would call four hundred
 * source files greenfield. That is not an edge case; it is how most existing
 * projects arrive at version control.
 *
 * So code and documentation *decide*, and history only ever corroborates in the
 * narrow band where there is a little code and it could be either a scaffold or
 * a young real project.
 */
export const THRESHOLDS = {
  /** Decisive. Is there already a system here to understand? */
  sourceFiles: 25,
  sourceBytes: 100_000,
  docBytes: 20_000,
  /** Below this, and with no source, nothing has been written down yet either. */
  emptyDocBytes: 2_000,

  /** Corroborating only. History is evidence of activity, never of code. */
  commits: 50,
  ageDays: 180,
  contributors: 3,
};

/**
 * @typedef {Object} Signals
 * @property {?number} commits       commits on the current branch
 * @property {?number} ageDays       days since the first commit
 * @property {?number} contributors  distinct commit authors
 * @property {?number} sourceFiles   tracked files that are not docs or config
 * @property {?number} docBytes      total bytes of documentation found
 * @property {?boolean} tests        does anything look like a test suite
 * @property {?boolean} ci           is there CI configuration
 * @property {string[]} agentFiles   CLAUDE.md, AGENTS.md, .cursorrules, …
 */

/**
 * Score one project, signal by signal.
 *
 * Each signal votes or abstains; a signal that could not be measured abstains
 * rather than counting as zero, which is the difference between "this repo has
 * no history" and "git could not be read".
 *
 * @param {Signals} signals
 * @returns {{verdict: string, confidence: string, votes: object[], why: string}}
 */
export function assessStage(signals = {}) {
  const T = THRESHOLDS;
  const has = (v) => v !== null && v !== undefined;

  // Every row is reported; only the decisive ones can settle it. `weight` is
  // what the report shows, so a reader can see which number did the deciding
  // rather than having to know the rule.
  const rows = [
    row('source files', signals.sourceFiles, T.sourceFiles, 'decisive', (v, t) => `${v} tracked source files (brownfield at ${t}+)`),
    row('source size', signals.sourceBytes, T.sourceBytes, 'decisive', (v, t) => `${kb(v)} of source (brownfield at ${kb(t)}+)`),
    row('documentation', signals.docBytes, T.docBytes, 'decisive', (v, t) => `${kb(v)} of documentation (brownfield at ${kb(t)}+)`),
    row('commits', signals.commits, T.commits, 'corroborating', (v, t) => `${v} commits (established at ${t}+)`),
    row('age', signals.ageDays, T.ageDays, 'corroborating', (v, t) => `first commit ${v} days ago (established at ${t}+)`),
    row('contributors', signals.contributors, T.contributors, 'corroborating', (v, t) => `${v} authors (established at ${t}+)`),
  ];

  const settle = (verdict, confidence, why) => ({ verdict, confidence, rows, why });

  // Nothing measurable at all is almost always a directory that is not a git
  // repository. That is a different answer from either stage.
  if (!has(signals.sourceFiles) && !has(signals.docBytes)) {
    return settle('unclear', 'none', 'no files could be listed — is this a git repository?');
  }

  // --- the decisive rules ---------------------------------------------------
  //
  // Is there already a system here? Nothing about history can answer that, and
  // nothing about history is consulted until these three have failed to.

  const manyFiles = has(signals.sourceFiles) && signals.sourceFiles >= T.sourceFiles;
  const muchCode = has(signals.sourceBytes) && signals.sourceBytes >= T.sourceBytes;
  if (manyFiles || muchCode) {
    const by = manyFiles ? `${signals.sourceFiles} source files` : `${kb(signals.sourceBytes)} of source`;
    return settle('brownfield', 'high', `there is already a codebase here — ${by}`);
  }

  if (has(signals.docBytes) && signals.docBytes >= T.docBytes) {
    // Documentation without much code is unusual but real — a spec repo, or a
    // codebase about to be imported. Either way there is something to absorb,
    // which is the question this answers.
    return settle('brownfield', 'high', `${kb(signals.docBytes)} of existing documentation to absorb`);
  }

  const noCode = has(signals.sourceFiles) && signals.sourceFiles === 0;
  const noDocs = !has(signals.docBytes) || signals.docBytes < T.emptyDocBytes;
  if (noCode && noDocs) {
    return settle('greenfield', 'high', 'no source files and no documentation — nothing has been built yet');
  }

  // --- the narrow band ------------------------------------------------------
  //
  // Some code, but not much: a generated scaffold and a young real project look
  // identical by file count, and this is the only place history can tell them
  // apart. It corroborates; it never overrules the rules above.

  const history = rows.filter((r) => r.weight === 'corroborating' && r.points);
  const established = history.filter((r) => r.points === 'brownfield').length;

  if (history.length && established * 2 > history.length) {
    return settle(
      'brownfield',
      'mixed',
      `only ${signals.sourceFiles ?? 'a few'} source files, but ${established} of ${history.length} history signals say it has been worked on`,
    );
  }

  return settle(
    'greenfield',
    'mixed',
    `${signals.sourceFiles ?? 'few'} source files and little history — this looks like scaffolding`,
  );
}

/** One row, abstaining when the signal could not be measured. */
function row(name, value, threshold, weight, why) {
  if (value === null || value === undefined) {
    return { name, value: null, threshold, weight, points: null, why: 'not measured' };
  }
  return {
    name,
    value,
    threshold,
    weight,
    points: value >= threshold ? 'brownfield' : 'greenfield',
    why: why(value, threshold),
  };
}

const kb = (bytes) => `${Math.round(bytes / 1024)}kB`;

/**
 * The assessment as lines, ending in the question a human has to answer.
 *
 * It always ends in a question, including when the verdict is confident: the
 * value of this is that somebody decided, and a report that reads as settled
 * invites the session to skip the deciding.
 */
export function describeStage(assessment, { agentFiles = [], tests = null, ci = null } = {}) {
  const L = [`stage:    ${assessment.verdict}   (${assessment.why})`, ''];

  // Decisive first, and labelled. A reader who disagrees with the verdict needs
  // to see which number produced it, not all six weighted equally.
  for (const group of ['decisive', 'corroborating']) {
    const rows = assessment.rows.filter((r) => r.weight === group);
    if (!rows.length) continue;
    L.push(`  ${group === 'decisive' ? 'is there a system here' : 'has it been worked on'}`);
    for (const r of rows) {
      const mark = r.points === 'brownfield' ? 'B' : r.points === 'greenfield' ? 'G' : '-';
      L.push(`    ${mark}  ${r.name.padEnd(14)} ${r.why}`);
    }
  }

  // Context rather than votes: these say what a survey would have to read, not
  // how old the project is.
  const context = [];
  if (tests !== null) context.push(`    .  ${'tests'.padEnd(14)} ${tests ? 'present' : 'none found'}`);
  if (ci !== null) context.push(`    .  ${'ci'.padEnd(14)} ${ci ? 'configured' : 'none found'}`);
  if (agentFiles.length) context.push(`    .  ${'agent docs'.padEnd(14)} ${agentFiles.join(', ')}`);
  if (context.length) L.push('  context', ...context);

  L.push('', 'This is a proposal, not a finding — confirm it before anything is written.');
  return L;
}
