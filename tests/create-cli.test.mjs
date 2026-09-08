/**
 * `dev create` end to end, against the `gh` stub.
 *
 * What these prove is *ordering* and *refusal* — that a duplicate scan ran
 * before anything was filed, that a refusal filed nothing, that an override
 * filed exactly once — which is the class of thing the stub is good for. The
 * matcher itself is unit-tested in create.test.mjs; here it only has to hit or
 * miss the two titles the stub holds.
 *
 * stdout is asserted byte for byte throughout. `create` prints the new ID and
 * nothing else on success, and the candidates and nothing else on refusal, so
 * a caller can capture either directly; a stray line there is a regression.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withStubGh } from './ghstub.mjs';

const filed = (log) => log.split('\n').filter((l) => l.startsWith('issue create')).length;

/**
 * A body the shipped default for `Bug` accepts outright: every section it
 * names, criteria non-empty. The #47 tests are about the duplicate scan, and a
 * body the template refuses would never reach it.
 */
const BODY = [
  '## Symptom', 'x', '## Steps to reproduce', 'x', '## Expected vs actual', 'x', '## Environment', 'x',
  '## Suspected area', 'x', '## Acceptance criteria', '- [ ] AC1: it works', '## Session context', 'x', '',
].join('\n');

const BUG_MD = `---
name: Bug report
about: Something is broken
title: "[Bug]: "
labels: bug, needs-triage
---

## Describe the bug

## To Reproduce

### Expected behavior
`;

const FORM_YML = `name: Bug form
description: File a bug.
title: "[Bug]: "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks!
  - type: textarea
    id: what
    attributes:
      label: What happened?
  - type: dropdown
    attributes:
      label: Version
      options:
        - 1.0
`;

const withLocalTemplates = (s, files) => {
  const dir = join(s.projectRoot, '.github', 'ISSUE_TEMPLATE');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
};

// --- the scan runs on every file --------------------------------------------------

test('a summary matching an open issue is refused: candidates out, exit 2, nothing filed', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', BODY]);

  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, '#12\tHalf a thing\n', 'stdout carries the candidates in --dup-check format');
  assert.match(r.stderr, /--allow-duplicate/, 'the refusal names the override flag');
  assert.match(r.stderr, /#12/, 'the refusal names what it matched');
  assert.equal(filed(s.read('log')), 0, 'nothing was filed');
  assert.equal(s.read('created'), '');
});

test('--allow-duplicate files anyway, says what it matched, and prints only the ID', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', BODY, '--allow-duplicate']);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n', 'stdout is the new ID alone');
  assert.match(r.stderr, /duplicate check overridden — matched #12/);
  assert.equal(filed(s.read('log')), 1);
  assert.match(s.read('created'), /^title\tHalf a thing is still broken\n/);
});

test('the flag may come before the positionals', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--allow-duplicate', 'Half a thing is still broken', BODY]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
});

test('no match files, and does not mention the flag', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Rotate the frobnicator quarterly', BODY]);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.doesNotMatch(r.stderr, /allow-duplicate|overridden/);
  assert.equal(filed(s.read('log')), 1);

  const searches = s.read('log').split('\n').filter((l) => /issue list .*--search/.test(l));
  assert.equal(searches.length, 1, 'the scan ran exactly once');
  assert.match(searches[0], /--search rotate frobnicator quarterly/, 'keywords come from the summary');
});

test('the scan runs before the write, never after it', async () => {
  const s = await withStubGh();
  await s.dev(['create', 'Rotate the frobnicator quarterly', BODY]);
  const lines = s.read('log').split('\n');
  const scan = lines.findIndex((l) => /issue list .*--search/.test(l));
  const write = lines.findIndex((l) => l.startsWith('issue create'));
  assert.ok(scan >= 0 && write >= 0);
  assert.ok(scan < write, 'the scan must precede the write');
});

// --- the check may never become a new way for filing to fail ----------------------

test('a search failure warns and files', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', BODY], { GH_FAIL_SEARCH: '1' });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /duplicate scan skipped — /);
  assert.match(r.stderr, /search is unavailable/, 'the reason is surfaced, not swallowed');
  assert.equal(filed(s.read('log')), 1);
});

// --- --dup-check alone is unchanged ------------------------------------------------
//
// skills/dev-init runs it as a credentials smoke test and reads "no open
// issues matched" or a list as success; both spellings and the exit code are
// load-bearing there.

test('--dup-check reports matches, exits 0, files nothing', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--dup-check', 'half']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#12\tHalf a thing\n');
  assert.equal(filed(s.read('log')), 0);
});

test('--dup-check with no match says so, exits 0', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--dup-check', 'frobnicator']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'no open issues matched\n');
});

test('--dup-check without keywords is a usage error', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--dup-check']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--dup-check needs a value/);
});

// --- usage --------------------------------------------------------------------------

test('an unknown flag is refused rather than read as a summary', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--bogus', 'x', 'y']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag --bogus/);
});

test('a summary that begins with a dash is filed when it comes after --', async () => {
  // A bug titled after the flag that is broken is exactly what this tracker
  // files; `--` is the one deterministic way to say "positional from here".
  const s = await withStubGh();
  const r = await s.dev(['create', '--', '--force flag does nothing on abandon', BODY]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(s.read('created'), /^title\t--force flag does nothing on abandon\n/);
});

test('a dash-led summary without -- is refused, and the refusal names --', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--force flag does nothing on abandon', BODY]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag --force flag does nothing on abandon/);
  assert.match(r.stderr, /after `--`/, 'the way out is in the message, not in a manual');
  assert.equal(s.read('log'), '', 'nothing scanned or filed');
});

test('flags before -- still apply; everything after it is positional', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--allow-duplicate', '--', 'Half a thing is still broken', BODY]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /duplicate check overridden/);
});

test('--template and -- coexist: the flag applies, the dash-led summary is positional', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD, 'bug.yml': FORM_YML });
  const r = await s.dev(['create', '--template', 'bug.yml', '--', '--dashy flag is broken', '### What happened?\nx\n### Version\n1.0\n', 'Bug']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /template: Bug form \(repo checkout\)/);
  assert.match(s.read('created'), /^title\t\[Bug\]: --dashy flag is broken\n/);
});

test('a whitespace-only summary is a usage error, with nothing scanned or filed', async () => {
  // '   ' is truthy; without a trim it would reach the scan as an empty
  // query, which a search backend reads as "no filter".
  const s = await withStubGh();
  const r = await s.dev(['create', '   ', BODY]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: dev\.mjs create/);
  assert.equal(s.read('log'), '');
});

test('a missing description is a usage error, with nothing scanned or filed', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'only a summary']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: dev\.mjs create/);
  assert.equal(s.read('log'), '');
});

// --- the issue template is a hard input (#36) ------------------------------------

test('AC1: a body missing a repo template heading is refused, naming it, and nothing is filed', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD });
  const r = await s.dev(['create', 'The export times out', '## Describe the bug\nx\n## To Reproduce\ny\n']);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Expected behavior/);
  assert.match(r.stderr, /bug_report\.md|Bug report/);
  assert.equal(filed(s.read('log')), 0);
});

test('AC2/AC5: a body carrying every heading is filed with the template labels and title prefix, source on stderr', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD });
  const body = '## Describe the bug\nx\n## To Reproduce\ny\n### Expected behavior\nz\n## Acceptance criteria\n- [ ] AC1: ok\n';
  const r = await s.dev(['create', 'The export times out', body]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /dev create: template: Bug report \(repo checkout\)/);
  const created = s.read('created');
  assert.match(created, /^title\t\[Bug\]: The export times out\n/);
  assert.match(created, /\nlabel\tbug\nlabel\tneeds-triage\n/);
  assert.ok(!s.read('log').includes('api repos/'), 'the API is not asked when the checkout has a template');
});

test('AC3: a .yml issue form is honoured, and ### <label> satisfies it', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug.yml': FORM_YML });
  const refused = await s.dev(['create', 'It broke', '### What happened?\nx\n']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Version/);
  const ok = await s.dev(['create', 'It broke', '### What happened?\nx\n### Version\n1.0\n']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, '#99\n');
  assert.match(ok.stderr, /template: Bug form \(repo checkout\)/);
});

test('AC15: a satisfied repo template with no criteria section is filed, with one warning', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD });
  const body = '## Describe the bug\nx\n## To Reproduce\ny\n### Expected behavior\nz\n';
  const r = await s.dev(['create', 'The export times out', body]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.equal((r.stderr.match(/acceptance criteria/gi) ?? []).length, 1, 'warned exactly once');
});

test('AC4: with no template in the checkout, discovery falls back to the API', async () => {
  const s = await withStubGh({ templates: { 'bug_report.md': BUG_MD } });
  const body = '## Describe the bug\nx\n## To Reproduce\ny\n### Expected behavior\nz\n';
  const r = await s.dev(['create', 'The export times out', body]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /template: Bug report \(repo via API\)/);
  assert.match(s.read('log'), /api repos\/o\/r\/contents\/\.github\/ISSUE_TEMPLATE\/bug_report\.md/);
  assert.match(s.read('created'), /^title\t\[Bug\]: The export times out\n/);
});

test('AC4/AC13: with none anywhere, the shipped default for the type applies and criteria are required', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Rotate the frobnicator', '## Problem\nx\n', 'Task']);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Acceptance criteria/);
  assert.equal(filed(s.read('log')), 0);
  assert.match(s.read('log'), /api repos\/o\/r\/contents\/\.github\/ISSUE_TEMPLATE/, 'the API was asked before falling back');

  const empty = await s.dev(['create', 'Rotate the frobnicator', '## Problem\nx\n## Acceptance criteria\n\n', 'Task']);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /Acceptance criteria/);
});

test('AC14/AC5: on the default path a missing non-criteria section is filed with a warning naming it', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Rotate the frobnicator', '## Symptom\nx\n## Acceptance criteria\n- [ ] AC1: y\n']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /template: Bug \(shipped default for Bug\)/);
  assert.match(r.stderr, /## Environment/);
  assert.equal(s.read('created').split('\n').filter((l) => l.startsWith('label\t')).length, 0, 'a default adds no labels');
  assert.match(s.read('created'), /^title\tRotate the frobnicator\n/, 'and no prefix');
});

test('AC6: two repo templates and no --template is refused listing both; --template picks one', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD, 'bug.yml': FORM_YML });
  const r = await s.dev(['create', 'It broke', '### What happened?\nx\n### Version\n1.0\n', 'Bug']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bug_report\.md/);
  assert.match(r.stderr, /bug\.yml/);
  assert.match(r.stderr, /--template/);
  assert.equal(filed(s.read('log')), 0);

  const ok = await s.dev(['create', 'It broke', '### What happened?\nx\n### Version\n1.0\n', 'Bug', '--template', 'bug.yml']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, '#99\n');
  assert.match(ok.stderr, /template: Bug form \(repo checkout\)/);
});

test('an unreadable template beside a readable one is warned about, not fatal', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD, 'bad.yml': 'body:\n  - attributes:\n      label: x\n' });
  const body = '## Describe the bug\nx\n## To Reproduce\ny\n### Expected behavior\nz\n';
  const r = await s.dev(['create', 'The export times out', body, 'Bug', '--template', 'bug_report.md']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '#99\n');
  assert.match(r.stderr, /bad\.yml/, 'the broken file is named');
  assert.match(r.stderr, /template: Bug report \(repo checkout\)/);

  const named = await s.dev(['create', 'The export times out', body, 'Bug', '--template', 'bad.yml']);
  assert.equal(named.code, 1);
  assert.match(named.stderr, /line 2/);
  assert.equal(filed(s.read('log')), 1, 'only the first run filed');
});

test('the template is checked before the duplicate scan and before any write', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', 'Half a thing is still broken', '## Problem\nno criteria\n']);
  assert.equal(r.code, 1);
  assert.ok(!/issue list .*--search/.test(s.read('log')), 'a body the template refuses is not scanned');
  assert.equal(filed(s.read('log')), 0);
});

// --- reading before drafting (AC7) ---------------------------------------------------

test('--templates lists the repo templates, filename and name', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD, 'bug.yml': FORM_YML });
  const r = await s.dev(['create', '--templates']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'bug.yml\tBug form\nbug_report.md\tBug report\n');
  assert.match(r.stderr, /repo checkout/);
});

test('--templates with none says so and names the shipped defaults', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--templates']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no repository issue templates/);
  assert.match(r.stdout, /Bug/);
  assert.match(r.stdout, /Task/);
});

test('--template <name> alone prints that template verbatim', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD, 'bug.yml': FORM_YML });
  const r = await s.dev(['create', '--template', 'bug_report.md']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, BUG_MD);
  const byName = await s.dev(['create', '--template', 'Bug form']);
  assert.equal(byName.stdout, FORM_YML);
});

test('--template <TYPE> alone prints the shipped default for a configured type', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--template', 'Epic']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^## Problem\n/);
  assert.match(r.stdout, /## Acceptance criteria\n- \[ \] AC1: /);
  assert.doesNotMatch(r.stdout, /Out of scope/, 'Epic is the generic skeleton, not the Feature one');
  const bug = await s.dev(['create', '--template', 'Bug']);
  assert.match(bug.stdout, /## Session context/);
});

test('--template with something that is neither exits non-zero listing both sets', async () => {
  const s = await withStubGh();
  withLocalTemplates(s, { 'bug_report.md': BUG_MD });
  const r = await s.dev(['create', '--template', 'nope']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /bug_report\.md/);
  assert.match(r.stderr, /Bug, Feature, Task, Epic, Improvement/);
});

test('--template needs a value', async () => {
  const s = await withStubGh();
  const r = await s.dev(['create', '--template']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--template needs a value/);
});
