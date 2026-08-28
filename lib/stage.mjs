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
 * They are deliberately unsubtle. The interesting cases — a young repo with
 * 40,000 lines of generated client, an ancient repo of three config files —
 * are exactly the ones no threshold gets right, which is why nothing here
 * decides alone.
 */
export const THRESHOLDS = {
  commits: 50,
  ageDays: 180,
  contributors: 3,
  sourceFiles: 50,
  docBytes: 4000,
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
  // One row per signal: what it is called, what was measured, the threshold it
  // is judged against, and how to say so. Kept as data so a reader can check
  // the whole rule at a glance rather than following five near-identical calls.
  const scale = [
    ['commits', signals.commits, THRESHOLDS.commits, (v, t) => `${v} commits (brownfield at ${t}+)`],
    ['age', signals.ageDays, THRESHOLDS.ageDays, (v, t) => `first commit ${v} days ago (brownfield at ${t}+)`],
    ['contributors', signals.contributors, THRESHOLDS.contributors, (v, t) => `${v} authors (brownfield at ${t}+)`],
    ['source files', signals.sourceFiles, THRESHOLDS.sourceFiles, (v, t) => `${v} tracked source files (brownfield at ${t}+)`],
    ['documentation', signals.docBytes, THRESHOLDS.docBytes, (v, t) => `${v} bytes of documentation (brownfield at ${t}+)`],
  ];

  // A signal that could not be measured abstains rather than scoring zero —
  // the difference between "this repo has no history" and "git could not be
  // read", which are opposite conclusions from the same missing number.
  const votes = scale.map(([name, value, threshold, why]) =>
    value === null || value === undefined
      ? { name, value: null, points: null, why: 'not measured' }
      : { name, value, points: value >= threshold ? 'brownfield' : 'greenfield', why: why(value, threshold) },
  );

  const counted = votes.filter((v) => v.points);
  const brown = counted.filter((v) => v.points === 'brownfield').length;
  const green = counted.length - brown;

  // Fewer than three measurable signals is not a verdict, it is an absence of
  // evidence — most often a directory that is not a git repository at all.
  if (counted.length < 3) {
    return {
      verdict: 'unclear',
      confidence: 'none',
      votes,
      why: `only ${counted.length} signal${counted.length === 1 ? '' : 's'} could be measured`,
    };
  }

  if (brown === green) {
    return { verdict: 'unclear', confidence: 'none', votes, why: `signals are split ${brown}–${green}` };
  }

  const verdict = brown > green ? 'brownfield' : 'greenfield';
  const majority = Math.max(brown, green);
  return {
    verdict,
    confidence: majority === counted.length ? 'high' : 'mixed',
    votes,
    why: `${majority} of ${counted.length} signals say ${verdict}`,
  };
}

/**
 * The assessment as lines, ending in the question a human has to answer.
 *
 * It always ends in a question, including when the verdict is confident: the
 * value of this is that somebody decided, and a report that reads as settled
 * invites the session to skip the deciding.
 */
export function describeStage(assessment, { agentFiles = [], tests = null, ci = null } = {}) {
  const L = [`stage:    ${assessment.verdict}   (${assessment.why})`, ''];

  for (const v of assessment.votes) {
    const mark = v.points === 'brownfield' ? 'B' : v.points === 'greenfield' ? 'G' : '-';
    L.push(`  ${mark}  ${v.name.padEnd(14)} ${v.why}`);
  }

  // Context rather than votes: these say what a survey would have to read, not
  // how old the project is.
  if (tests !== null) L.push(`  .  ${'tests'.padEnd(14)} ${tests ? 'present' : 'none found'}`);
  if (ci !== null) L.push(`  .  ${'ci'.padEnd(14)} ${ci ? 'configured' : 'none found'}`);
  if (agentFiles.length) L.push(`  .  ${'agent docs'.padEnd(14)} ${agentFiles.join(', ')}`);

  L.push('', 'This is a proposal, not a finding — confirm it before anything is written.');
  return L;
}
