/**
 * The review payloads, and the single source of truth for the lens text.
 *
 * Two properties are worth a test here. `diffRange` decides what a reviewer is
 * shown, and getting the range operator wrong is invisible until a reviewer is
 * handed somebody else's commits as if the branch had made them. And the lens
 * files are read by two independent consumers — the /dev-review skill and the
 * CI action — which is exactly the drift this repo refuses everywhere else.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeVcs, DEFAULT_DIFF_EXCLUDES } from '../lib/vcs.mjs';
import { normalizeFindings, markAgreement, renderReport, anchorOf } from '../lib/review.mjs';
import { buildContext } from '../scripts/cmd/review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LENSES = join(ROOT, 'skills', 'dev-review', 'lenses');

function fakeRun(replies = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args.join(' '));
    const key = Object.keys(replies).find((k) => args.join(' ').includes(k));
    const r = key ? replies[key] : {};
    return { ok: r.ok ?? true, code: r.ok === false ? 1 : 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  run.calls = calls;
  return run;
}

// --- diffRange ----------------------------------------------------------------

test('the diff is three-dot, so base commits are not reported as the branch reversing them', async () => {
  const run = fakeRun({
    'rev-parse': { stdout: 'ok' },
    'diff --name-only': { stdout: 'lib/a.mjs' },
    'diff --numstat': { stdout: '3\t1\tlib/a.mjs' },
  });
  const vcs = makeVcs({ run });
  const r = await vcs.diffRange('/repo', { base: 'main' });

  assert.equal(r.ok, true);
  assert.ok(run.calls.some((c) => c.includes('main...HEAD')), 'expected a three-dot range');
  assert.ok(!run.calls.some((c) => /main\.\.HEAD/.test(c) && !/main\.\.\.HEAD/.test(c)));
});

test('lockfiles, build output and generated source never reach a reviewer', async () => {
  const run = fakeRun({
    'rev-parse': { stdout: 'ok' },
    'diff --name-only': { stdout: 'lib/a.mjs\npnpm-lock.yaml\ndist/bundle.js\nsrc/api.generated.ts' },
    'diff --numstat': { stdout: '3\t1\tlib/a.mjs' },
  });
  const r = await makeVcs({ run }).diffRange('/repo', { base: 'main' });
  assert.deepEqual(r.files, ['lib/a.mjs']);
});

test('a missing base ref names the ref rather than diffing against nothing', async () => {
  const run = fakeRun({ 'rev-parse': { ok: false } });
  const r = await makeVcs({ run }).diffRange('/repo', { base: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such ref "nope"/);
});

test('nothing reviewable is an empty review, not an error', async () => {
  const run = fakeRun({ 'rev-parse': { stdout: 'ok' }, 'diff --name-only': { stdout: '' } });
  const r = await makeVcs({ run }).diffRange('/repo', { base: 'main' });
  assert.deepEqual(r, { ok: true, patch: '', files: [], lines: 0 });
});

test('a binary file counts as zero reviewable lines rather than NaN', async () => {
  const run = fakeRun({
    'rev-parse': { stdout: 'ok' },
    'diff --name-only': { stdout: 'img.png\nlib/a.mjs' },
    'diff --numstat': { stdout: '-\t-\timg.png\n2\t2\tlib/a.mjs' },
  });
  const r = await makeVcs({ run }).diffRange('/repo', { base: 'main' });
  assert.equal(r.lines, 4);
});

test('what the installer generates is not reviewable work', () => {
  const hit = (f) => DEFAULT_DIFF_EXCLUDES.some((re) => re.test(f));

  // A byte-identical copy of source already in the diff. Counting it doubles
  // every payload change and pushes routine work past the review ceiling.
  assert.ok(hit('_dev-workflow/lib/vcs.mjs'));
  assert.ok(hit('.claude/skills/dev-review/SKILL.md'));
  assert.ok(hit('.claude/skills/dev-review/lenses/blind.md'));

  // But only the namespace the installer owns. A hand-written skill beside ours
  // is the user's own work and must still be reviewed — the same line
  // isOwnedPath draws.
  assert.ok(!hit('.claude/skills/my-own-skill/SKILL.md'));
  assert.ok(!hit('.claude/settings.json'));
  assert.ok(!hit('skills/dev-review/SKILL.md'), 'the source of a skill is reviewable');
});

test('the exclude list is exported so the CI payload and the command agree', () => {
  assert.ok(DEFAULT_DIFF_EXCLUDES.some((re) => re.test('pnpm-lock.yaml')));
  assert.ok(DEFAULT_DIFF_EXCLUDES.some((re) => re.test('dist/x.js')));
  assert.ok(!DEFAULT_DIFF_EXCLUDES.some((re) => re.test('lib/vcs.mjs')));
});

// --- context payload ----------------------------------------------------------

test('one enormous file cannot crowd the rest out of the context payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  writeFileSync(join(dir, 'huge.txt'), 'x'.repeat(250_000));
  writeFileSync(join(dir, 'small.mjs'), 'export const a = 1;\n');

  const out = buildContext(['huge.txt', 'small.mjs'], { root: dir });
  assert.ok(out.includes('=== small.mjs ==='), 'the small file survives');
  assert.ok(!out.includes('x'.repeat(1000)), 'the huge file is not inlined');
  assert.ok(out.includes('payload budget exhausted'), 'and the omission is reported');
});

test('a deleted file is skipped rather than crashing the payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  writeFileSync(join(dir, 'here.mjs'), 'ok\n');
  const out = buildContext(['gone.mjs', 'here.mjs'], { root: dir });
  assert.ok(out.includes('=== here.mjs ==='));
  assert.ok(!out.includes('gone.mjs'));
});

// --- the lenses are one source of truth ---------------------------------------

test('every lens the skill names exists and carries no frontmatter', () => {
  for (const lens of ['blind', 'edge', 'audit']) {
    const path = join(LENSES, `${lens}.md`);
    assert.ok(existsSync(path), `${lens}.md should exist`);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.trim().length > 400, `${lens}.md looks truncated`);
    assert.ok(
      !text.startsWith('---'),
      `${lens}.md must be prompt text only: it is fed to a model verbatim, and frontmatter would be read as instructions`,
    );
  }
});

test('the CI action reads the lenses from the skill rather than carrying its own copy', () => {
  const script = join(ROOT, '.github', 'scripts', 'adversarial-review.mjs');
  if (!existsSync(script)) return; // repo-local action, absent in the published tarball
  const text = readFileSync(script, 'utf8');

  assert.ok(
    text.includes('skills/dev-review/lenses/'),
    'the action must read skills/dev-review/lenses/, not inline its own prompts',
  );
  for (const marker of ['const BLIND = `', 'const EDGE = `', 'const AUDIT = `']) {
    assert.ok(!text.includes(marker), `the action still inlines a lens (${marker.trim()})`);
  }
});

test('the skill points at the lenses it ships beside', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'dev-review', 'SKILL.md'), 'utf8');
  for (const lens of ['blind', 'edge', 'audit']) {
    assert.ok(skill.includes(`lenses/${lens}.md`), `SKILL.md should name lenses/${lens}.md`);
  }
});

// --- findings: schema and rendering -------------------------------------------

const F = (over = {}) => ({
  file: 'lib/a.mjs', line: 10, severity: 'major', bucket: 'patch',
  title: 'a thing is wrong', problem: 'it does the wrong thing',
  consequence: 'callers get bad data', fix: 'do the right thing', ...over,
});

test('a finding with no title has nothing to act on and is dropped', () => {
  const { findings, dropped } = normalizeFindings({ findings: [F(), { file: 'x.mjs' }, null] }, 'blind');
  assert.equal(findings.length, 1);
  assert.equal(dropped, 2);
});

test('a model that returns a bad severity does not fail the review', () => {
  const { findings } = normalizeFindings({ findings: [F({ severity: 'catastrophic' })] }, 'blind');
  assert.equal(findings[0].severity, 'minor', 'falls back rather than printing a severity nobody defined');
});

test('a line given as a string is still an anchor', () => {
  const { findings } = normalizeFindings({ findings: [F({ line: '42' })] }, 'edge');
  assert.equal(findings[0].line, 42);
  assert.equal(anchorOf(findings[0]), 'lib/a.mjs:42');
});

test('an unplaceable finding degrades to the file rather than claiming line 0', () => {
  const { findings } = normalizeFindings({ findings: [F({ line: null })] }, 'edge');
  assert.equal(findings[0].line, null);
  assert.equal(anchorOf(findings[0]), 'lib/a.mjs');
});

test('ids are stable across runs, so a repeat finding is recognisable', () => {
  const a = normalizeFindings({ findings: [F()] }, 'blind').findings[0];
  const b = normalizeFindings({ findings: [F()] }, 'blind').findings[0];
  assert.equal(a.id, b.id);
  const c = normalizeFindings({ findings: [F()] }, 'edge').findings[0];
  assert.notEqual(a.id, c.id, 'the same defect from a different lens is a different finding');
});

test('two lenses landing on one line is the signal worth surfacing', () => {
  const marked = markAgreement([
    ...normalizeFindings({ findings: [F()] }, 'blind').findings,
    ...normalizeFindings({ findings: [F({ title: 'said differently' })] }, 'audit').findings,
    ...normalizeFindings({ findings: [F({ line: 99 })] }, 'edge').findings,
  ]);
  assert.deepEqual(marked[0].alsoRaisedBy, ['audit']);
  assert.deepEqual(marked[1].alsoRaisedBy, ['blind']);
  assert.deepEqual(marked[2].alsoRaisedBy, [], 'a lone finding agrees with nobody');
});

test('unanchored findings are never called agreement', () => {
  const marked = markAgreement([
    ...normalizeFindings({ findings: [F({ line: null })] }, 'blind').findings,
    ...normalizeFindings({ findings: [F({ line: null })] }, 'audit').findings,
  ]);
  assert.deepEqual(marked[0].alsoRaisedBy, []);
});

test('the report is ordered worst-first and byte-identical on a re-render', () => {
  const input = {
    model: 'm',
    meta: { files: 2, lines: 40 },
    lenses: [
      { name: 'blind', findings: normalizeFindings({ findings: [F({ severity: 'nit', title: 'z' }), F({ severity: 'blocker', title: 'a' })] }, 'blind').findings },
    ],
  };
  const once = renderReport(input);
  assert.equal(once, renderReport(input), 'same input, same bytes');
  assert.ok(once.indexOf('### Blockers') < once.indexOf('### Nits'));
});

test('every finding renders as a checkbox an agent can address', () => {
  const out = renderReport({
    lenses: [{ name: 'blind', findings: normalizeFindings({ findings: [F()] }, 'blind').findings }],
  });
  assert.match(out, /- \[ \] `lib\/a\.mjs:10` — \*\*a thing is wrong\*\*/);
  assert.match(out, /\*\*Fix:\*\* do the right thing/);
});

test('the JSON block carries every finding, so an agent can read only that', () => {
  const out = renderReport({
    model: 'mistral-large-latest',
    meta: { files: 1, lines: 12 },
    lenses: [
      { name: 'blind', findings: normalizeFindings({ findings: [F()] }, 'blind').findings },
      { name: 'edge', findings: normalizeFindings({ findings: [F({ line: 77, trigger: 'ids = []' })] }, 'edge').findings },
    ],
  });
  const json = JSON.parse(out.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(json.findings.length, 2);
  assert.equal(json.model, 'mistral-large-latest');
  assert.ok(json.findings.every((f) => f.id && f.severity && f.title));
  assert.equal(json.findings.find((f) => f.lens === 'edge').trigger, 'ids = []');
});

test('a lens that failed is named in the report rather than silently missing', () => {
  const out = renderReport({
    lenses: [
      { name: 'blind', findings: normalizeFindings({ findings: [F()] }, 'blind').findings },
      { name: 'edge', error: 'HTTP 429 — rate limited' },
    ],
  });
  assert.match(out, /### Lenses that did not report/);
  assert.match(out, /\*\*edge\*\* — HTTP 429/);
  assert.match(out, /across 1 lens\b/, 'and the count reflects what actually ran');
});

test('a clean diff says so instead of printing empty headings', () => {
  const out = renderReport({ lenses: [{ name: 'blind', findings: [] }, { name: 'edge', findings: [] }] });
  assert.match(out, /No findings across 2 lenses/);
  assert.ok(!out.includes('### Blockers'));
});

test('a trigger containing backticks does not close its own code span', () => {
  const out = renderReport({
    lenses: [{ name: 'edge', findings: normalizeFindings({ findings: [F({ trigger: 'ids = `[]`' })] }, 'edge').findings }],
  });
  // The exact input is the field that makes an edge finding actionable; a span
  // that closes early renders the rest as prose and loses it.
  assert.match(out, /\*Trigger:\* `` ids = `\[\]` ``/);
});

test('every lens failing is reported as no review, never as a clean one', () => {
  const out = renderReport({
    lenses: [
      { name: 'blind', error: 'HTTP 403 — tier_not_allowed' },
      { name: 'edge', error: 'HTTP 403 — tier_not_allowed' },
      { name: 'audit', error: 'HTTP 403 — tier_not_allowed' },
    ],
    meta: { files: 8, lines: 639 },
  });
  // The failure this guards against is a reader skimming the first line and
  // taking a total outage for a pass.
  assert.match(out, /\*\*This review did not run\.\*\*/);
  assert.match(out, /Do not read this as a pass/);
  assert.ok(!out.includes('No findings'), 'must not say "No findings" when nothing ran');
});
