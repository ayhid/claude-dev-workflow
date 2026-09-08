/**
 * lib/issuetemplate.mjs: what a repository's issue template says an issue must
 * look like, and whether a drafted body says it.
 *
 * Fixtures are inline and in both formats GitHub reads — markdown with
 * frontmatter, and an issue form — because the two normalise to one shape and
 * the tests are what prove they do. Discovery runs against a real temporary
 * directory rather than a fake fs: the ordering rules are about file names on
 * disk, and a fake would only prove the fake.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_TEMPLATES,
  applyTemplate,
  defaultTemplateFor,
  describeSource,
  discoverLocal,
  discoverTemplates,
  headingsOf,
  parseFrontmatter,
  parseIssueForm,
  parseMarkdownTemplate,
  parseTemplate,
  renderTemplate,
  selectTemplate,
  validateBody,
} from '../lib/issuetemplate.mjs';

const BUG_MD = `---
name: Bug report
about: Something is broken
title: "[Bug]: "
labels: bug, needs-triage
---

## Describe the bug

A clear description.

## To Reproduce

Steps.

### Expected behavior

What you expected.
`;

const FORM_YML = `name: Bug Report
description: File a bug report.
title: "[Bug]: "
labels: ["bug", "triage"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to fill out this bug report!
        ## Not a section
  - type: input
    id: contact
    attributes:
      label: Contact Details
      description: How can we get in touch?
      placeholder: ex. email@example.com
    validations:
      required: false
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Also tell us, what did you expect to happen?
    validations:
      required: true
  - type: dropdown
    id: version
    attributes:
      label: Version
      options:
        - 1.0.2 (Default)
        - 1.0.3 (Edge)
`;

// --- frontmatter ----------------------------------------------------------------

test('parseFrontmatter reads the fields and hands back the body', () => {
  const r = parseFrontmatter(BUG_MD);
  assert.equal(r.fields.name, 'Bug report');
  assert.equal(r.fields.about, 'Something is broken');
  assert.equal(r.fields.title, '[Bug]: ', 'quotes are stripped, inner whitespace kept');
  assert.deepEqual(r.fields.labels, ['bug', 'needs-triage'], 'a csv labels line is a list');
  assert.match(r.body, /^## Describe the bug/);
});

test('parseFrontmatter is optional: no block means no fields and the whole text as body', () => {
  const r = parseFrontmatter('## Only a body\n');
  assert.deepEqual(r.fields, {});
  assert.equal(r.body, '## Only a body\n');
});

test('parseFrontmatter reads labels as [a, b] and as a block list', () => {
  assert.deepEqual(parseFrontmatter('---\nlabels: [a, "b c"]\n---\n').fields.labels, ['a', 'b c']);
  assert.deepEqual(parseFrontmatter('---\nlabels:\n  - a\n  - b\n---\n').fields.labels, ['a', 'b']);
});

// --- markdown templates ----------------------------------------------------------

test('parseMarkdownTemplate: the ## and ### headings of the body are the sections', () => {
  const r = parseMarkdownTemplate('bug_report.md', BUG_MD);
  assert.ok(r.ok, r.error);
  const t = r.template;
  assert.equal(t.name, 'Bug report');
  assert.equal(t.filename, 'bug_report.md');
  assert.equal(t.title, '[Bug]: ');
  assert.deepEqual(t.labels, ['bug', 'needs-triage']);
  assert.deepEqual(t.sections, ['Describe the bug', 'To Reproduce', 'Expected behavior']);
  assert.equal(t.text, BUG_MD, 'the raw text is kept, so --template prints it verbatim');
});

test('a markdown template without frontmatter is named after its file', () => {
  const r = parseMarkdownTemplate('feature.md', '## Problem\n\n## Fix\n');
  assert.ok(r.ok);
  assert.equal(r.template.name, 'feature');
  assert.deepEqual(r.template.sections, ['Problem', 'Fix']);
  assert.deepEqual(r.template.labels, []);
  assert.equal(r.template.title, '');
});

test('headingsOf ignores headings inside a code fence', () => {
  const h = headingsOf('## Real\n\n```md\n## Not real\n```\n\n### Also real\n');
  assert.deepEqual(h.map((x) => x.text), ['Real', 'Also real']);
});

// --- issue forms -----------------------------------------------------------------

test('parseIssueForm: every non-markdown body item label is a section, in order', () => {
  const r = parseIssueForm('bug.yml', FORM_YML);
  assert.ok(r.ok, r.error);
  const t = r.template;
  assert.equal(t.name, 'Bug Report');
  assert.equal(t.title, '[Bug]: ');
  assert.deepEqual(t.labels, ['bug', 'triage']);
  assert.deepEqual(t.sections, ['Contact Details', 'What happened?', 'Version']);
  assert.equal(t.text, FORM_YML);
});

test('parseIssueForm refuses a body item without a type, naming the line', () => {
  const r = parseIssueForm('bad.yml', 'name: x\nbody:\n  - attributes:\n      label: Oops\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /line 3/);
  assert.match(r.error, /type/);
});

test('parseTemplate dispatches on the extension and refuses the rest', () => {
  assert.ok(parseTemplate('a.md', BUG_MD).ok);
  assert.ok(parseTemplate('a.yml', FORM_YML).ok);
  assert.ok(parseTemplate('a.yaml', FORM_YML).ok);
  const r = parseTemplate('a.txt', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /a\.txt/);
});

// --- discovery -------------------------------------------------------------------

const repoWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};

test('discoverLocal reads .github/ISSUE_TEMPLATE sorted, skipping config.yml', () => {
  const root = repoWith({
    '.github/ISSUE_TEMPLATE/zeta.md': '## Z\n',
    '.github/ISSUE_TEMPLATE/alpha.yml': FORM_YML,
    '.github/ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: false\n',
    '.github/ISSUE_TEMPLATE/notes.txt': 'not a template',
    'ISSUE_TEMPLATE.md': '## Legacy\n',
  });
  assert.deepEqual(
    discoverLocal(root).map((f) => f.filename),
    ['alpha.yml', 'zeta.md'],
    'the directory wins over the legacy file, and config.yml is not a template',
  );
});

test('discoverLocal falls back to the three legacy single-file locations', () => {
  const root = repoWith({
    'docs/ISSUE_TEMPLATE.md': '## Docs legacy\n',
    'ISSUE_TEMPLATE.md': '## Root legacy\n',
  });
  assert.deepEqual(
    discoverLocal(root).map((f) => f.filename),
    ['docs/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE.md'],
  );
  assert.deepEqual(discoverLocal(repoWith({})), []);
});

test('discoverTemplates: the checkout first, and the API is never asked when it has one', async () => {
  const root = repoWith({ '.github/ISSUE_TEMPLATE/bug_report.md': BUG_MD });
  let asked = false;
  const provider = { capabilities: { issueTemplates: true }, async templates() { asked = true; return { ok: true, data: [] }; } };
  const r = await discoverTemplates({ root, provider });
  assert.ok(r.ok, r.error);
  assert.equal(r.source, 'checkout');
  assert.deepEqual(r.templates.map((t) => t.filename), ['bug_report.md']);
  assert.equal(asked, false);
});

test('discoverTemplates: an empty checkout asks the API when the capability is declared', async () => {
  const root = repoWith({});
  const provider = {
    capabilities: { issueTemplates: true },
    async templates() { return { ok: true, data: [{ filename: 'bug.yml', text: FORM_YML }, { filename: 'config.yml', text: 'x: y\n' }] }; },
  };
  const r = await discoverTemplates({ root, provider });
  assert.ok(r.ok, r.error);
  assert.equal(r.source, 'api');
  assert.deepEqual(r.templates.map((t) => t.filename), ['bug.yml'], 'config.yml is skipped over the API too');
});

test('discoverTemplates: no capability means no lookup and source none', async () => {
  const root = repoWith({});
  let asked = false;
  const provider = { capabilities: { issueTemplates: false }, async templates() { asked = true; return { ok: true, data: [] }; } };
  const r = await discoverTemplates({ root, provider });
  assert.ok(r.ok);
  assert.equal(r.source, 'none');
  assert.deepEqual(r.templates, []);
  assert.equal(asked, false);
});

test('discoverTemplates: a repo whose only template is unreadable is an error naming the file', async () => {
  // Not a fall-through to the shipped default: the project stated a shape,
  // and filing the generic skeleton against a broken template would be the
  // silent substitution this module exists to stop.
  const root = repoWith({ '.github/ISSUE_TEMPLATE/bad.yml': 'body:\n  - attributes:\n      label: x\n' });
  const r = await discoverTemplates({ root, provider: { capabilities: { issueTemplates: false } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /bad\.yml/);
  assert.match(r.error, /line 2/);
});

test('discoverTemplates: one unreadable template does not take the readable ones down with it', async () => {
  const root = repoWith({
    '.github/ISSUE_TEMPLATE/bug_report.md': BUG_MD,
    '.github/ISSUE_TEMPLATE/bad.yml': 'body:\n  - attributes:\n      label: x\n',
  });
  const r = await discoverTemplates({ root, provider: { capabilities: { issueTemplates: false } } });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.templates.map((t) => t.filename), ['bug_report.md']);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].filename, 'bad.yml');
  assert.match(r.unreadable[0].error, /type/);
});

test('selectTemplate: naming the unreadable template is refused with its parse error, not "not found"', () => {
  const unreadable = [{ filename: 'bad.yml', error: 'bad.yml, line 2: a body item needs a "type"' }];
  const r = selectTemplate({ templates: [bug], source: 'checkout', name: 'bad.yml', unreadable });
  assert.equal(r.ok, false);
  assert.match(r.error, /line 2/);
  assert.match(r.error, /type/);
  // And with one readable template left, no name is still that one.
  assert.equal(selectTemplate({ templates: [bug], source: 'checkout', unreadable }).template, bug);
});

// --- selection -------------------------------------------------------------------

const bug = parseMarkdownTemplate('bug_report.md', BUG_MD).template;
const form = parseIssueForm('bug.yml', FORM_YML).template;

test('selectTemplate: one repo template needs no name', () => {
  const r = selectTemplate({ templates: [bug], source: 'checkout', type: 'Bug' });
  assert.ok(r.ok, r.error);
  assert.equal(r.template, bug);
  assert.equal(r.source, 'checkout');
});

test('selectTemplate: several repo templates and no name is refused, listing them', () => {
  const r = selectTemplate({ templates: [bug, form], source: 'checkout', type: 'Bug' });
  assert.equal(r.ok, false);
  assert.match(r.error, /bug_report\.md/);
  assert.match(r.error, /bug\.yml/);
  assert.match(r.error, /--template/);
});

test('selectTemplate: a name picks by filename or by name, and an unknown one lists the rest', () => {
  assert.equal(selectTemplate({ templates: [bug, form], source: 'checkout', name: 'bug.yml' }).template, form);
  assert.equal(selectTemplate({ templates: [bug, form], source: 'checkout', name: 'Bug report' }).template, bug);
  const r = selectTemplate({ templates: [bug, form], source: 'checkout', name: 'nope.md' });
  assert.equal(r.ok, false);
  assert.match(r.error, /nope\.md/);
  assert.match(r.error, /bug_report\.md/);
});

test('selectTemplate: no repo templates means the shipped default for the type', () => {
  const r = selectTemplate({ templates: [], source: 'none', type: 'Task' });
  assert.ok(r.ok, r.error);
  assert.equal(r.source, 'default');
  assert.equal(r.template, defaultTemplateFor('Task'));
});

test('selectTemplate: --template with no repo templates to choose from is refused', () => {
  const r = selectTemplate({ templates: [], source: 'none', name: 'bug_report.md', type: 'Bug' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no issue templates/i);
});

// --- shipped defaults (AC12) ------------------------------------------------------

test('a default exists for Bug and Feature, and every other type is the generic one', () => {
  assert.deepEqual(DEFAULT_TEMPLATES.Bug.sections, [
    'Symptom', 'Steps to reproduce', 'Expected vs actual', 'Environment', 'Suspected area',
    'Acceptance criteria', 'Session context',
  ]);
  assert.deepEqual(DEFAULT_TEMPLATES.Feature.sections, [
    'Problem', 'Proposed change', 'In scope', 'Out of scope', 'Acceptance criteria',
  ]);
  assert.deepEqual(DEFAULT_TEMPLATES.generic.sections, ['Problem', 'Proposed change', 'Acceptance criteria']);
  assert.equal(defaultTemplateFor('Bug'), DEFAULT_TEMPLATES.Bug);
  assert.equal(defaultTemplateFor('bug'), DEFAULT_TEMPLATES.Bug, 'type names compare ignoring case');
  assert.equal(defaultTemplateFor('Feature'), DEFAULT_TEMPLATES.Feature);
  for (const t of ['Task', 'Epic', 'Improvement']) {
    assert.equal(defaultTemplateFor(t), DEFAULT_TEMPLATES.generic, `${t} must get the generic skeleton`);
  }
});

test('renderTemplate prints a repo template verbatim and a default as its skeleton', () => {
  assert.equal(renderTemplate(bug), BUG_MD);
  const out = renderTemplate(DEFAULT_TEMPLATES.Feature);
  assert.match(out, /^## Problem\n/);
  assert.match(out, /## Acceptance criteria\n- \[ \] AC1: /);
  assert.equal(out, renderTemplate(DEFAULT_TEMPLATES.Feature), 'byte-stable');
});

// --- validation ------------------------------------------------------------------

test('AC1: a body missing a repo template heading is refused naming it', () => {
  const r = validateBody('## Describe the bug\nx\n## To Reproduce\ny\n', bug, { source: 'checkout' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['Expected behavior']);
});

test('AC2: a body carrying every repo heading passes, extra sections never fail', () => {
  const body = '## Describe the bug\nx\n## To Reproduce\ny\n### Expected behavior\nz\n## Extra\nw\n';
  const r = validateBody(body, bug, { source: 'checkout' });
  assert.ok(r.ok, r.missing.join(','));
  assert.deepEqual(r.missing, []);
});

test('AC3: ### <label> satisfies a form section, and heading case does not matter', () => {
  const body = '### Contact Details\nme\n### what happened?\nit broke\n## Version\n1.0.3\n';
  const r = validateBody(body, form, { source: 'api' });
  assert.ok(r.ok, r.missing.join(','));
});

test('AC15: a satisfied repo template with no criteria section passes with one warning', () => {
  const body = '## Describe the bug\nx\n## To Reproduce\ny\n### Expected behavior\nz\n';
  const r = validateBody(body, bug, { source: 'checkout' });
  assert.ok(r.ok);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /acceptance criteria/i);
});

test('AC13: on the default path, missing or empty criteria is refused for every type', () => {
  for (const type of ['Bug', 'Feature', 'Task', 'Epic', 'Improvement']) {
    const t = defaultTemplateFor(type);
    const none = validateBody('## Problem\nx\n', t, { source: 'default' });
    assert.equal(none.ok, false, `${type}: no criteria must refuse`);
    assert.deepEqual(none.missing, ['Acceptance criteria']);

    const empty = validateBody('## Problem\nx\n## Acceptance criteria\n\n\n## Assumptions\nnone\n', t, { source: 'default' });
    assert.equal(empty.ok, false, `${type}: an empty criteria section must refuse`);
    assert.deepEqual(empty.missing, ['Acceptance criteria']);
  }
});

test('the printed placeholder left unedited does not count as criteria', () => {
  // `create --template Bug` prints `- [ ] AC1: ` under the heading. Filing that
  // verbatim is the empty section wearing a checkbox.
  for (const type of ['Bug', 'Feature', 'Task']) {
    const t = defaultTemplateFor(type);
    const r = validateBody(renderTemplate(t), t, { source: 'default' });
    assert.equal(r.ok, false, `${type}: the unedited skeleton must refuse`);
    assert.deepEqual(r.missing, ['Acceptance criteria']);
  }
  const ticked = validateBody('## Acceptance criteria\n- [ ] AC1:\n- [x] \n- [ ]\n', DEFAULT_TEMPLATES.generic, { source: 'default' });
  assert.equal(ticked.ok, false, 'checkboxes with nothing after them are not criteria');
  const real = validateBody('## Acceptance criteria\n- [ ] AC1: the export completes\n', DEFAULT_TEMPLATES.generic, { source: 'default' });
  assert.ok(real.ok);
});

test('a section is a ## or ### heading, in the body as in the template', () => {
  // The template reader takes sections from level 2 and 3 headings only; the
  // validator holds the body to the same rule, or a `#### Acceptance criteria`
  // satisfies a check its own template file would not have defined.
  const t = DEFAULT_TEMPLATES.generic;
  assert.equal(validateBody('#### Acceptance criteria\n- [ ] AC1: x\n', t, { source: 'default' }).ok, false);
  assert.equal(validateBody('# Acceptance criteria\n- [ ] AC1: x\n', t, { source: 'default' }).ok, false);
  assert.ok(validateBody('### Acceptance criteria\n- [ ] AC1: x\n', t, { source: 'default' }).ok);
});

test('AC14: on the default path, a missing non-criteria section is a warning, not a refusal', () => {
  const r = validateBody('## Symptom\nx\n## Acceptance criteria\n- [ ] AC1: y\n', DEFAULT_TEMPLATES.Bug, { source: 'default' });
  assert.ok(r.ok);
  assert.deepEqual(r.missing, []);
  assert.ok(r.warnings.some((w) => /Environment/.test(w)), 'the warning names the section');
  assert.ok(r.warnings.some((w) => /Steps to reproduce/.test(w)));
});

test('a complete body on the default path is silent', () => {
  const body = renderTemplate(DEFAULT_TEMPLATES.generic).replace(/AC1: /, 'AC1: it works');
  const r = validateBody(body, DEFAULT_TEMPLATES.generic, { source: 'default' });
  assert.ok(r.ok);
  assert.deepEqual(r.warnings, []);
});

// --- applying frontmatter ----------------------------------------------------------

test('applyTemplate prefixes the title once and hands over the labels', () => {
  const a = applyTemplate(bug, 'the export times out');
  assert.equal(a.summary, '[Bug]: the export times out');
  assert.deepEqual(a.labels, ['bug', 'needs-triage']);
  const again = applyTemplate(bug, a.summary);
  assert.equal(again.summary, a.summary, 'the prefix is idempotent');
});

test('applyTemplate on a default template changes nothing', () => {
  const a = applyTemplate(DEFAULT_TEMPLATES.Bug, 'plain');
  assert.equal(a.summary, 'plain');
  assert.deepEqual(a.labels, []);
});

test('describeSource says where the template came from', () => {
  assert.equal(describeSource('checkout', bug), 'repo checkout');
  assert.equal(describeSource('api', bug), 'repo via API');
  assert.equal(describeSource('default', defaultTemplateFor('Epic'), 'Epic'), 'shipped default for Epic');
});
