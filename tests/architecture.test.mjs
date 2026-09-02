/**
 * The target architecture: the documents a project should end up with.
 *
 * JSON is JSON. YAML is a deliberately narrow subset — a `sections:` list of
 * flat id/title/description mappings — and everything outside it is refused by
 * line number rather than mis-parsed. A parser that is usually right is worse
 * than one that says no.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArchitecture } from '../lib/architecture.mjs';

const JSON_ARCH = JSON.stringify({
  sections: [
    { id: 'architecture', title: 'Architecture', description: 'How it is built' },
    { id: 'operations', title: 'Operations', description: 'How it is run' },
  ],
});

const YAML_ARCH = `# the target set
sections:
  - id: architecture
    title: "Architecture"
    description: 'How it is built'

  - id: operations
    title: Operations
    description: How it is run # runbook
`;

test('JSON and the YAML subset parse to the same sections', () => {
  const fromJson = parseArchitecture(JSON_ARCH, { format: 'json' });
  const fromYaml = parseArchitecture(YAML_ARCH, { format: 'yaml' });
  assert.equal(fromJson.ok, true, fromJson.error);
  assert.equal(fromYaml.ok, true, fromYaml.error);
  assert.deepEqual(fromYaml.sections, fromJson.sections);
  assert.deepEqual(fromJson.sections[1], { id: 'operations', title: 'Operations', description: 'How it is run' });
});

test('the indented-key form (id on its own line) is accepted too', () => {
  const r = parseArchitecture(`sections:\n  -\n    id: a\n    title: A\n    description: d\n`, { format: 'yaml' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.sections[0].id, 'a');
});

test('a section needs an id that is a safe file stem, and ids are unique', () => {
  for (const sections of [
    [{ title: 'A', description: 'd' }],
    [{ id: 'has space', title: 'A', description: 'd' }],
    [{ id: '../up', title: 'A', description: 'd' }],
    [{ id: 'a', title: 'A', description: 'd' }, { id: 'a', title: 'B', description: 'd' }],
  ]) {
    const r = parseArchitecture(JSON.stringify({ sections }), { format: 'json' });
    assert.equal(r.ok, false, JSON.stringify(sections));
    assert.match(r.error, /id/);
  }
});

test('a section needs a title; description is required but may be short', () => {
  const noTitle = parseArchitecture(JSON.stringify({ sections: [{ id: 'a', description: 'd' }] }), { format: 'json' });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.error, /title/);
  const noDesc = parseArchitecture(JSON.stringify({ sections: [{ id: 'a', title: 'A' }] }), { format: 'json' });
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.error, /description/);
});

test('an architecture with no sections, or a top-level shape that is not {sections}, is refused', () => {
  assert.equal(parseArchitecture('{"sections": []}', { format: 'json' }).ok, false);
  assert.equal(parseArchitecture('[]', { format: 'json' }).ok, false);
  const bad = parseArchitecture('not json', { format: 'json' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON/);
});

test('the YAML subset refuses what it cannot read, naming the line', () => {
  const cases = [
    ['unknown top-level key', `version: 2\nsections:\n  - id: a\n    title: A\n    description: d\n`, /line 1/],
    ['unknown section key', `sections:\n  - id: a\n    title: A\n    description: d\n    owner: me\n`, /line 5.*owner/],
    ['inline mapping', `sections:\n  - { id: a, title: A, description: d }\n`, /line 2/],
    ['nested mapping', `sections:\n  - id: a\n    title: A\n    description:\n      long: d\n`, /line 4|line 5/],
    ['multi-line scalar', `sections:\n  - id: a\n    title: A\n    description: |\n      two\n      lines\n`, /line 4/],
    ['a list item that is not a mapping', `sections:\n  - a\n`, /line 2/],
    ['tabs', `sections:\n\t- id: a\n`, /line 2.*tab/i],
    ['a value that is a list', `sections:\n  - id: a\n    title: [A]\n    description: d\n`, /line 3/],
  ];
  for (const [name, text, re] of cases) {
    const r = parseArchitecture(text, { format: 'yaml' });
    assert.equal(r.ok, false, name);
    assert.match(r.error, re, `${name}: ${r.error}`);
  }
});

test('the format is decided by the caller, from the file extension', () => {
  const r = parseArchitecture(YAML_ARCH, { format: 'toml' });
  assert.equal(r.ok, false);
  assert.match(r.error, /json|yaml/i);
});

test('an unterminated quote is refused, not read as a value', () => {
  const r = parseArchitecture(`sections:\n  - id: a\n    title: "A\n    description: d\n`, { format: 'yaml' });
  assert.equal(r.ok, false);
  assert.match(r.error, /line 3.*quote/);
});
