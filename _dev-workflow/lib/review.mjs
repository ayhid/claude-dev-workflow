/**
 * Review findings: the schema the lenses emit, and the comment they render into.
 *
 * The output contract is here rather than in the CI action because a finding has
 * two audiences and they want different things from the same bytes. A person
 * scanning a pull request wants severity first and a fix they can act on. An
 * agent picking the review up wants a field it can address without parsing
 * English. A checkbox list over a JSON block serves both without keeping two
 * copies of the findings, which would drift the moment one was edited.
 *
 * Rendering is a pure function of validated findings, so the same review renders
 * the same bytes every time (contract rule 4) and the whole thing is testable
 * without an API key.
 */

/** Worst first. Anything outside this list sorts last and is reported as-is. */
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];

/**
 * Where a finding goes, which is the question a reader actually has. Copied from
 * the triage the lenses already teach: fixing the code and fixing the spec are
 * different work, and doing the first to a bad spec encodes the mistake.
 */
export const BUCKETS = ['intent-gap', 'bad-spec', 'scope-creep', 'patch', 'deferred'];

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const rank = (s) => SEVERITY_RANK[s] ?? SEVERITIES.length;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** What a finding that named no file is anchored to. Not a path, and never a merge key. */
export const UNATTRIBUTED = '(unattributed)';

/**
 * Shorter than this, a quote matches something by accident and proves nothing.
 * `}` appears in every file; `if (!ok) return null;` does not.
 */
const MIN_EVIDENCE = 12;

/** Whitespace-insensitive, so a quote survives re-indentation and diff prefixes. */
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * The same text with unified-diff markers taken off the front of each line.
 *
 * A single-line quote already survived them: `squash` collapses the space after
 * the `+` and the quote matches from the character after it. A **multi-line**
 * one did not, because the marker sits *between* the joined lines — a model
 * quoting two consecutive added lines verbatim produced `a; b;` against a
 * haystack reading `+a; +b;`, and a real finding was held back as unverified.
 *
 * Only ever used to widen the haystack, never to narrow it, so a quote that
 * matched before still matches.
 */
const unmarked = (v) => String(v ?? '').replace(/^[+-]/gm, '');

/**
 * Did the finding quote code that actually exists?
 *
 * This is the only check here that a model cannot talk its way past, and it
 * exists because of a real run: a lens reported five boundary failures against
 * one numeric guard, four of which that guard already handled. Describing code
 * is easy to get wrong; reproducing it is not. A finding whose quote is absent
 * from the payload has not been shown to be about this diff at all.
 *
 * Unverified is not the same as false, so nothing is deleted — it is segregated,
 * and the reader is told which pile is which.
 */
export function verifyEvidence(findings, source) {
  const hay = squash(source);
  const bare = squash(unmarked(source));
  if (!hay) return findings.map((f) => ({ ...f, verified: null }));
  return findings.map((f) => {
    const quote = squash(f.evidence);
    // Three states, not two, because `false` is an accusation. It is reserved for
    // a quote that was looked for and not found — the lens describing code it
    // imagined, which is the whole reason this check exists. A finding that
    // supplied no quote, or one too short to tell a real match from an accident,
    // was never checked at all; filing it under "quoted code that is not in this
    // diff" says something about it that is not true, and hides it while saying
    // it. A blocker whose author omitted one field was disappearing that way.
    if (quote.length < MIN_EVIDENCE) {
      return { ...f, verified: null, unchecked: quote ? 'quote too short to check' : 'no evidence quoted' };
    }
    return { ...f, verified: hay.includes(quote) || bare.includes(quote) };
  });
}

/**
 * A short, deterministic id for a finding.
 *
 * Deterministic so a re-run of an unchanged branch produces the same ids and a
 * reader can tell a repeat finding from a new one. Not a hash import: this needs
 * to survive in an environment with no crypto, and it is an identifier rather
 * than a security boundary.
 */
export function findingId(lens, f) {
  const seed = `${lens}|${f.file}|${f.line}|${f.title}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return `${lens.slice(0, 2)}-${h.toString(36).slice(0, 6)}`;
}

/**
 * Coerce one lens's JSON into findings we are willing to print.
 *
 * A model asked for JSON will occasionally return a field as a number, omit one,
 * or wrap the array in another key. None of that is worth failing a review over,
 * so the shape is repaired where it can be and the finding is dropped only when
 * it has no anchor and no title — at which point there is nothing to act on.
 *
 * @returns {{findings: object[], dropped: number}}
 */
export function normalizeFindings(raw, lens) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : [];
  const findings = [];
  let dropped = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      dropped++;
      continue;
    }
    const title = str(item.title) || str(item.problem) || str(item.summary);
    const file = str(item.file) || str(item.path);
    if (!title) {
      dropped++;
      continue;
    }

    const lineRaw = item.line ?? item.lineNumber;
    // A line number is a positive integer or it is not a line number. isFinite
    // alone let 1.5 through, which anchors a finding at a line no file has —
    // found by the edge lens on the first live run, and the one thing it got right.
    const line = Number.isInteger(Number(lineRaw)) && Number(lineRaw) > 0 ? Number(lineRaw) : null;
    const severity = SEVERITIES.includes(str(item.severity)) ? str(item.severity) : 'minor';
    const bucket = BUCKETS.includes(str(item.bucket)) ? str(item.bucket) : '';

    const f = {
      lens,
      file: file || UNATTRIBUTED,
      line,
      severity,
      bucket,
      title,
      // The line(s) the finding accuses, copied from the payload. Checked against
      // it by verifyEvidence rather than trusted.
      evidence: str(item.evidence),
      problem: str(item.problem),
      consequence: str(item.consequence),
      fix: str(item.fix),
      // Lens-specific, all optional: edge carries the reproduction, audit the
      // verdict on a criterion. Printed when present, never invented.
      trigger: str(item.trigger),
      behavior: str(item.behavior),
      test: str(item.test),
    };
    f.id = findingId(lens, f);
    findings.push(f);
  }

  // A lens needs somewhere to put diligence and uncertainty that is not the
  // findings array. Without these, the only way to show it did the work is to
  // report something — which is how an enumeration prompt fills the array.
  const strings = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

  return {
    findings,
    dropped,
    questions: strings(raw?.questions),
    axesChecked: strings(raw?.axesChecked ?? raw?.axes_checked),
  };
}

/** `path:line`, or just the path when the lens could not anchor it. */
export const anchorOf = (f) => (f.line ? `${f.file}:${f.line}` : f.file);

/** Lens order, for deterministic tie-breaking when two are equally detailed. */
const LENS_ORDER = ['blind', 'edge', 'audit'];

/** How much a finding actually says, for choosing which of a group to lead with. */
const detail = (f) =>
  [f.problem, f.consequence, f.fix, f.trigger, f.behavior, f.test, f.evidence].filter(Boolean).length;

/**
 * One entry per place in the code, however many lenses spoke about it.
 *
 * Three lenses reaching one defect is the strongest signal in a review — and
 * printing it three times is the fastest way to make a 17-line diff look like it
 * has seven problems. That happened: six of seven findings landed on one line,
 * four of them the same off-by-one in different words.
 *
 * What this deliberately does NOT do is decide which of them are the same defect.
 * The obvious approach is to compare titles and proposed fixes, and it does not
 * work: "MAX_PER_GROUP silently drops findings" and "off-by-one in MAX_PER_GROUP
 * slice" are the same defect and share three tokens out of seventeen, while the
 * two genuinely different complaints on that line shared more. A threshold that
 * separates them on one sample is a threshold fitted to one sample.
 *
 * So the claim made here is only the one the data supports: these findings are
 * about the same line. They become one entry with one checkbox — an agent fixing
 * that line addresses all of them — and every other title and fix is kept beneath
 * it, since the lens that explains it best is not reliably the one with the most
 * fields.
 */
export function mergeFindings(findings) {
  const byLocation = new Map();
  for (const f of findings) {
    // An unanchored finding cannot be shown to be about the same code as another,
    // so it always keeps its own entry. A missing *file* is just as unanchored
    // as a missing line: the contract the report states to its reader is "same
    // file, same line", and two `(unattributed)` findings that happen to share
    // a line number are not about the same code. Merging them manufactures the
    // one signal the report tells that reader to trust most.
    //
    // `verified` splits the entries too, because the two piles are two
    // different claims — one quote was found in the payload and the other was
    // not — and `...primary` below would otherwise hand the merged finding
    // whichever verdict the primary happened to carry, in either direction.
    const anchored = f.line && f.file && f.file !== UNATTRIBUTED;
    const key = anchored ? `${anchorOf(f)}|${f.verified ?? 'unchecked'}` : `#${f.id}`;
    byLocation.set(key, [...(byLocation.get(key) ?? []), f]);
  }

  return [...byLocation.values()].map((items) => {
    // Severity first, and that ordering is the fix for a real defect rather than
    // a preference. Ranking by detail alone chose the most *described* finding
    // while severity was computed separately across the group, so the two came
    // from different items: a blind blocker merged with a wordier nit rendered
    // under "Blockers" with the nit's title and the nit's fix, and the blocker's
    // own remediation left the report entirely. The entry's severity and the
    // prose explaining it now always belong to the same finding.
    const primary = [...items].sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) ||
        detail(b) - detail(a) ||
        LENS_ORDER.indexOf(a.lens) - LENS_ORDER.indexOf(b.lens) ||
        a.id.localeCompare(b.id),
    )[0];
    // Union of what each item already carries, so merging a merged set is a
    // no-op rather than quietly discarding the phrasings from the first pass.
    const lenses = [...new Set(items.flatMap((i) => i.lenses ?? [i.lens]))].sort();
    // Worst severity wins: one lens calling it a nit does not downgrade another
    // lens calling it a blocker. Taken from `primary` rather than computed across
    // the group a second time — primary is now the worst-severity item, so one
    // expression cannot drift from the other.
    const severity = primary.severity;
    return {
      ...primary,
      severity,
      lenses,
      alsoRaisedBy: lenses.filter((l) => l !== primary.lens),
      alsoSaid: [
        ...(primary.alsoSaid ?? []),
        // The fix travels with the title. A second lens's concrete remediation
        // for the same line reached the reader in neither half of the report,
        // which is review content the merge claimed to preserve and did not.
        ...items
          .filter((i) => i !== primary)
          .flatMap((i) => [`${i.lens}: ${i.title}${i.fix ? ` — ${i.fix}` : ''}`, ...(i.alsoSaid ?? [])]),
      ],
    };
  });
}

/** Worst first, then stable by file and line so a re-run prints the same order. */
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      // "A finding two lenses reach independently is almost always real. Mark
      // it and put it first" — skills/dev-review/SKILL.md, which the reader is
      // shown. Ordering by file first left an uncorroborated finding above a
      // corroborated one, so the report contradicted the instructions printed
      // underneath it.
      (b.alsoRaisedBy?.length ?? 0) - (a.alsoRaisedBy?.length ?? 0) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

const HEADINGS = {
  blocker: 'Blockers',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nits',
};

/**
 * Wrap a value as inline code, in a fence long enough to survive its contents.
 *
 * A lens is asked for the exact triggering input, and exact inputs contain
 * backticks. A single-backtick span around one closes early and the rest of the
 * finding renders as prose, which loses precisely the field that made it
 * actionable.
 */
function code(v) {
  const longest = Math.max(0, ...[...String(v).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(v) ? ' ' : '';
  return `${fence}${pad}${v}${pad}${fence}`;
}

function renderFinding(f) {
  const tags = [(f.lenses ?? [f.lens]).join(' + '), f.bucket].filter(Boolean).join(' · ');
  // The reason agreement matters is stated once, in the summary. Repeating it on
  // every finding buries the finding itself.
  const agree = f.alsoRaisedBy?.length ? ' · **reached independently**' : '';

  const lines = [`- [ ] \`${anchorOf(f)}\` — **${f.title}**  <sub>${tags}${agree}</sub>`];
  const detail = [];
  if (f.problem && f.problem !== f.title) detail.push(f.problem);
  if (f.consequence) detail.push(`*Consequence:* ${f.consequence}`);
  if (f.trigger) detail.push(`*Trigger:* ${code(f.trigger)}`);
  if (f.behavior) detail.push(`*Behaviour:* ${f.behavior}`);
  if (f.test) detail.push(`*Test:* ${f.test}`);
  if (f.fix) detail.push(`**Fix:** ${f.fix}`);
  // Kept in the main list, but not passed off as checked. This is the middle
  // state: not verified, and not accused of being invented either.
  if (f.unchecked) detail.push(`*Not verified:* ${f.unchecked}`);
  for (const said of f.alsoSaid ?? []) detail.push(`<sub>also: ${said}</sub>`);
  for (const d of detail) lines.push(`      ${d}`);
  return lines.join('\n');
}

/**
 * The whole comment.
 *
 * `evidenceChecked` defaults to false, and the default is the safe direction: a
 * caller that did not say whether it verified the quotes did not verify them, and
 * a report that cannot promise the check must not read like one that can.
 *
 * @param {{lenses: {name: string, findings?: object[], error?: string, skipped?: string}[],
 *          model?: string, meta?: {files?: number, lines?: number},
 *          evidenceChecked?: boolean}} input
 */
export function renderReport({ lenses = [], model = 'unknown', meta = {}, evidenceChecked = false } = {}) {
  const all = mergeFindings(lenses.flatMap((l) => l.findings ?? []));
  // Unverified findings are held back rather than deleted: the quote may have been
  // reformatted rather than invented. But they do not get to sit in the list a
  // reader works through, because the cost of the pile is that it stops being read.
  const sorted = sortFindings(all.filter((f) => f.verified !== false));
  const unverified = sortFindings(all.filter((f) => f.verified === false));
  const agreed = sorted.filter((f) => f.alsoRaisedBy?.length).length;

  const out = ['## Adversarial review', ''];

  const ran = lenses.filter((l) => !l.error && !l.skipped).map((l) => l.name);
  // `!= null`, not truthiness: zero is a measurement, and it is the one worth
  // printing. A change set filtered down to nothing reviewed nothing, and a
  // report that silently omits the scope there reads like one that had none.
  const scope = [
    meta.files != null ? `${meta.files} file${meta.files === 1 ? '' : 's'}` : '',
    meta.lines != null ? `${meta.lines} changed line${meta.lines === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');

  // No lens reporting is not a clean review, it is no review, and the two must
  // never read alike at a glance. "No findings across 0 lenses" is the sentence
  // a reader skims and takes for a pass.
  if (ran.length === 0) {
    out.push(
      `**This review did not run.** None of the ${lenses.length} lens${lenses.length === 1 ? '' : 'es'} reported` +
        `${scope ? `, so ${scope} went unreviewed` : ''} — see below. Do not read this as a pass.`,
      '',
    );
  } else {
    out.push(
      sorted.length === 0
        ? `No findings across ${ran.length} lens${ran.length === 1 ? '' : 'es'}${scope ? ` over ${scope}` : ''}.`
        : `**${sorted.length} finding${sorted.length === 1 ? '' : 's'}** across ${ran.length} lens${
            ran.length === 1 ? '' : 'es'
          }${scope ? ` over ${scope}` : ''}.`,
      '',
    );
    if (unverified.length) {
      out.push(
        `${unverified.length} more quoted code that is not in this diff, and ${
          unverified.length === 1 ? 'is' : 'are'
        } held back below.`,
        '',
      );
    }
    // Said out loud, because the alternative is silence that reads as a pass: an
    // unchecked report and a checked one were byte-identical, so a reader had no
    // way to tell a verified quote from a lens's unsupported claim.
    if (!evidenceChecked && sorted.length) {
      out.push(
        '**Evidence was not checked.** No payload directory was given, so every quote below is ' +
          'what the lens said it was accusing, not text matched against the code. Re-run with ' +
          '`--payloads` to have them verified.',
        '',
      );
    }
  }

  if (agreed) {
    out.push(
      `${agreed} of them were reached by more than one lens independently — start there.`,
      '',
    );
  }

  for (const sev of SEVERITIES) {
    const group = sorted.filter((f) => f.severity === sev);
    if (!group.length) continue;
    out.push(`### ${HEADINGS[sev]} (${group.length})`, '');
    for (const f of group) out.push(renderFinding(f), '');
  }

  const broken = lenses.filter((l) => l.error || l.skipped);
  if (broken.length) {
    out.push('### Lenses that did not report', '');
    for (const l of broken) out.push(`- **${l.name}** — ${l.error ?? l.skipped}`);
    out.push('');
  }

  if (unverified.length) {
    out.push(
      '<details>',
      `<summary>${unverified.length} finding${unverified.length === 1 ? '' : 's'} whose quoted code was not found in the diff</summary>`,
      '',
      'Each of these quoted something that is not in the payload it was given. That is',
      'usually a finding about code the lens imagined rather than read — the failure mode',
      'this check exists for — but a reformatted quote lands here too, so they are held',
      'back rather than deleted.',
      '',
    );
    for (const f of unverified) out.push(renderFinding(f), '');
    out.push('</details>', '');
  }

  const questions = lenses.flatMap((l) => (l.questions ?? []).map((q) => [l.name, q]));
  if (questions.length) {
    out.push(
      '<details>',
      `<summary>${questions.length} thing${questions.length === 1 ? '' : 's'} a lens could not explain from the diff alone</summary>`,
      '',
      'Not defects. Code that works and does not say so is a real cost, but it is a',
      'different one, and filing it as a bug is what buries the bugs.',
      '',
    );
    for (const [lens, q] of questions) out.push(`- <sub>${lens}</sub> ${q}`);
    out.push('', '</details>', '');
  }

  const axes = lenses.flatMap((l) => (l.axesChecked ?? []).map((a) => [l.name, a]));
  if (axes.length) {
    out.push(
      '<details>',
      '<summary>What was checked and found handled</summary>',
      '',
      'Coverage a reader can judge, without a finding having to be produced to prove it.',
      '',
    );
    for (const [lens, a] of axes) out.push(`- <sub>${lens}</sub> ${a}`);
    out.push('', '</details>', '');
  }

  // The machine half. Everything above is derived from this, so an agent that
  // reads only this block has the whole review and nothing is stated twice.
  out.push(
    '<details>',
    '<summary>Findings as JSON — for an agent picking this up</summary>',
    '',
    '```json',
    JSON.stringify(
      {
        model,
        ...meta,
        findings: [...sorted, ...unverified].map(({ lens, id, file, line, severity, bucket, title, problem, consequence, fix, trigger, behavior, test, alsoRaisedBy, alsoSaid, evidence, verified, unchecked, lenses }) => ({
          id, lens, file, line, severity, bucket, title,
          ...(lenses?.length > 1 ? { lenses } : {}),
          // The prose half renders these; a machine half that drops them is the
          // two halves disagreeing, which is the one thing this block promises
          // cannot happen.
          ...(alsoSaid?.length ? { alsoSaid } : {}),
          ...(evidence ? { evidence } : {}),
          ...(verified === false ? { verified: false } : {}),
          ...(unchecked ? { unchecked } : {}),
          ...(problem ? { problem } : {}),
          ...(consequence ? { consequence } : {}),
          ...(fix ? { fix } : {}),
          ...(trigger ? { trigger } : {}),
          ...(behavior ? { behavior } : {}),
          ...(test ? { test } : {}),
          ...(alsoRaisedBy?.length ? { alsoRaisedBy } : {}),
        })),
      },
      null,
      2,
    ),
    '```',
    '',
    '</details>',
    '',
    '<sub>Buckets: **intent-gap** fix the code · **bad-spec** fix the spec first · ' +
      '**patch** a local defect · **scope-creep** nobody agreed to maintain it · ' +
      '**deferred** real but out of scope.</sub>',
  );

  return `${out.join('\n')}\n`;
}
