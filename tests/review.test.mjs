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
