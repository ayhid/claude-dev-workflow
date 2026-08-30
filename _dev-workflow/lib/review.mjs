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
    const line = Number.isFinite(Number(lineRaw)) && Number(lineRaw) > 0 ? Number(lineRaw) : null;
    const severity = SEVERITIES.includes(str(item.severity)) ? str(item.severity) : 'minor';
    const bucket = BUCKETS.includes(str(item.bucket)) ? str(item.bucket) : '';

    const f = {
      lens,
      file: file || '(unattributed)',
      line,
      severity,
      bucket,
      title,
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

  return { findings, dropped };
}

/** `path:line`, or just the path when the lens could not anchor it. */
export const anchorOf = (f) => (f.line ? `${f.file}:${f.line}` : f.file);

/**
 * Tag findings that more than one lens put in the same place.
 *
 * The lenses' own triage says a finding raised by both the blind pass and the
 * audit is almost always real — the code neither says what it does nor does what
 * was asked. That is the single most useful signal in the whole report, and it
 * only exists once the lenses are read together.
 */
export function markAgreement(findings) {
  const byAnchor = new Map();
  for (const f of findings) {
    if (!f.line) continue; // an unanchored finding cannot be said to agree with anything
    const key = anchorOf(f);
    byAnchor.set(key, (byAnchor.get(key) ?? new Set()).add(f.lens));
  }
  return findings.map((f) => {
    const lenses = f.line ? byAnchor.get(anchorOf(f)) : null;
    const others = lenses ? [...lenses].filter((l) => l !== f.lens) : [];
    return { ...f, alsoRaisedBy: others.sort() };
  });
}

/** Worst first, then stable by file and line so a re-run prints the same order. */
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
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
  const tags = [f.lens, f.bucket].filter(Boolean).join(' · ');
  // The reason agreement matters is stated once, in the summary. Repeating it on
  // every finding buries the finding itself.
  const agree = f.alsoRaisedBy?.length ? ` · **also raised by ${f.alsoRaisedBy.join(', ')}**` : '';

  const lines = [`- [ ] \`${anchorOf(f)}\` — **${f.title}**  <sub>${tags}${agree}</sub>`];
  const detail = [];
  if (f.problem && f.problem !== f.title) detail.push(f.problem);
  if (f.consequence) detail.push(`*Consequence:* ${f.consequence}`);
  if (f.trigger) detail.push(`*Trigger:* ${code(f.trigger)}`);
  if (f.behavior) detail.push(`*Behaviour:* ${f.behavior}`);
  if (f.test) detail.push(`*Test:* ${f.test}`);
  if (f.fix) detail.push(`**Fix:** ${f.fix}`);
  for (const d of detail) lines.push(`      ${d}`);
  return lines.join('\n');
}

/**
 * The whole comment.
 *
 * @param {{lenses: {name: string, findings?: object[], error?: string, skipped?: string}[],
 *          model?: string, meta?: {files?: number, lines?: number}}} input
 */
export function renderReport({ lenses = [], model = 'unknown', meta = {} } = {}) {
  const all = markAgreement(lenses.flatMap((l) => l.findings ?? []));
  const sorted = sortFindings(all);
  const agreed = sorted.filter((f) => f.alsoRaisedBy?.length).length;

  const out = ['## Adversarial review', ''];

  const ran = lenses.filter((l) => !l.error && !l.skipped).map((l) => l.name);
  const scope = [
    meta.files ? `${meta.files} file${meta.files === 1 ? '' : 's'}` : '',
    meta.lines ? `${meta.lines} changed line${meta.lines === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');

  // No lens reporting is not a clean review, it is no review, and the two must
  // never read alike at a glance. "No findings across 0 lenses" is the sentence
  // a reader skims and takes for a pass.
  if (ran.length === 0) {
    out.push(
      `**This review did not run.** All ${lenses.length} lens${lenses.length === 1 ? '' : 'es'} failed` +
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
        findings: sorted.map(({ lens, id, file, line, severity, bucket, title, problem, consequence, fix, trigger, behavior, test, alsoRaisedBy }) => ({
          id, lens, file, line, severity, bucket, title,
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
