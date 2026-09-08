/**
 * Lifecycle triage: a rule proposes what a document *is* — a description of
 * the system, a record of a moment, or generated — from its path alone, and
 * every proposal names the rule, so a bulk answer is an answer about a
 * pattern rather than 309 separate judgements.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTriage,
  LIFECYCLES,
  proposeLifecycle,
  proposeTriage,
  renderTriage,
  RULES,
} from '../lib/doclife.mjs';

// --- proposeLifecycle: one path, one lifecycle, one rule ------------------------

test('a dated snapshot is historical, and the proposal names the rule', () => {
  const p = proposeLifecycle('docs/sprints/change-proposal-2025-12-20.md');
  assert.equal(p.lifecycle, 'historical');
  assert.equal(p.rule, 'dated-name');
});

test('stories, epics, proposals, analyses, reports, PRDs and briefs are records of moments', () => {
  const cases = [
    ['docs/stories/login-flow.md', 'stories-dir'],
    ['docs/epics/billing.md', 'stories-dir'],
    ['docs/proposals/cache-layer.md', 'proposal'],
    ['docs/gap-analysis.md', 'analysis'],
    ['docs/validation-report.md', 'report'],
    ['docs/prd/search.md', 'prd'],
    ['docs/search-prd.md', 'prd'],
    ['docs/briefs/q3.md', 'brief'],
  ];
  for (const [path, rule] of cases) {
    const p = proposeLifecycle(path);
    assert.equal(p.lifecycle, 'historical', path);
    assert.equal(p.rule, rule, path);
  }
});

test('a README, an architecture document and a manual stay reference even with a date in the name', () => {
  for (const path of ['README.md', 'docs/README-2025-01-01.md', 'docs/architecture-2024.md', 'docs/manual/setup.md']) {
    assert.equal(proposeLifecycle(path).lifecycle, 'reference', path);
  }
  assert.equal(proposeLifecycle('docs/architecture-2024.md').rule, 'architecture');
});

test('the generated patterns classifyPath excludes are generated here too', () => {
  assert.equal(proposeLifecycle('CHANGELOG.md').lifecycle, 'generated');
  assert.equal(proposeLifecycle('LICENSE.md').lifecycle, 'generated');
});

test('a path no rule matches is reference by the default rule, never unclassified', () => {
  const p = proposeLifecycle('docs/configuration.md');
  assert.equal(p.lifecycle, 'reference');
  assert.equal(p.rule, 'default-reference');
});

test('every rule names a lifecycle from the closed list, and the default comes last', () => {
  for (const r of RULES) {
    assert.ok(LIFECYCLES.includes(r.lifecycle), `${r.id}: ${r.lifecycle}`);
    assert.ok(r.text, `${r.id} has text`);
  }
  assert.equal(RULES.at(-1).id, 'default-reference');
});

// --- proposeTriage: paths grouped by rule, in rule order ---------------------------

test('proposeTriage groups by rule in RULES order, paths sorted, and the grouping is stable', () => {
  const paths = ['docs/b-2025-01-01.md', 'docs/a-2025-01-01.md', 'README.md', 'docs/stories/x.md', 'docs/guide.md'];
  const groups = proposeTriage(paths);
  assert.deepEqual(
    groups.map((g) => [g.rule, g.lifecycle, g.paths]),
    [
      ['readme', 'reference', ['README.md']],
      ['dated-name', 'historical', ['docs/a-2025-01-01.md', 'docs/b-2025-01-01.md']],
      ['stories-dir', 'historical', ['docs/stories/x.md']],
      ['default-reference', 'reference', ['docs/guide.md']],
    ],
  );
  assert.deepEqual(proposeTriage([...paths].reverse()), groups);
});

test('renderTriage prints one line per rule with its count and at most five sample paths', () => {
  const paths = Array.from({ length: 7 }, (_, i) => `docs/report-${i}.md`);
  const out = renderTriage(proposeTriage([...paths, 'README.md'])).join('\n');
  assert.match(out, /readme .*1 document/);
  assert.match(out, /report .*7 documents/);
  assert.match(out, /docs\/report-4\.md/);
  assert.doesNotMatch(out, /docs\/report-5\.md/);
  assert.match(out, /\+2 more/);
});

// --- applyTriage: answers become verdicts -------------------------------------------

const groups = () => proposeTriage(['docs/a-2025-01-01.md', 'docs/stories/x.md', 'README.md', 'docs/guide.md']);

test('a rule confirmed historical yields an archive verdict per path, naming the rule in its justification', () => {
  const r = applyTriage(groups(), { rules: { 'dated-name': 'historical' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdicts, [
    { path: 'docs/a-2025-01-01.md', classification: 'archive', justification: `triage rule dated-name: ${RULES.find((x) => x.id === 'dated-name').text}` },
  ]);
});

test('an unanswered rule is counted as skipped and not applied', () => {
  const r = applyTriage(groups(), { rules: { 'dated-name': 'historical' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped.map((s) => s.rule), ['readme', 'stories-dir', 'default-reference']);
  assert.equal(r.skipped.reduce((n, s) => n + s.count, 0), 3);
});

test('a rule answered reference or generated produces no verdict — only historical is a call about the document', () => {
  const r = applyTriage(groups(), { rules: { 'dated-name': 'reference', 'stories-dir': 'generated' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdicts, []);
  assert.deepEqual(r.applied.map((a) => [a.rule, a.lifecycle, a.count]), [['dated-name', 'reference', 1], ['stories-dir', 'generated', 1]]);
});

test('a path answer overrides its rule', () => {
  const r = applyTriage(groups(), {
    rules: { 'dated-name': 'historical', 'default-reference': 'reference' },
    paths: { 'docs/a-2025-01-01.md': 'reference', 'docs/guide.md': 'historical' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdicts.map((v) => v.path), ['docs/guide.md']);
  assert.match(r.verdicts[0].justification, /^triage path override: /);
});

test('the applied count is the paths the rule itself decided — an overridden path is not reported under its rule', () => {
  const g = proposeTriage(['docs/a-2025-01-01.md', 'docs/b-2024-05-05.md', 'docs/guide.md']);
  const r = applyTriage(g, {
    rules: { 'dated-name': 'historical', 'default-reference': 'reference' },
    paths: { 'docs/a-2025-01-01.md': 'reference', 'docs/guide.md': 'historical' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdicts.map((v) => v.path), ['docs/b-2024-05-05.md', 'docs/guide.md']);
  assert.deepEqual(r.applied.map((a) => [a.rule, a.lifecycle, a.count]), [['dated-name', 'historical', 1], ['default-reference', 'reference', 0]]);
  assert.equal(r.overridden, 2);
  assert.deepEqual(r.skipped, []);
});

test('an unknown rule id, an unknown lifecycle or a path outside the groups is refused', () => {
  assert.match(applyTriage(groups(), { rules: { bogus: 'historical' } }).error, /bogus/);
  assert.match(applyTriage(groups(), { rules: { 'dated-name': 'ancient' } }).error, /ancient/);
  assert.match(applyTriage(groups(), { paths: { 'ghost.md': 'historical' } }).error, /ghost\.md/);
  assert.match(applyTriage(groups(), { paths: { 'README.md': 'later' } }).error, /later/);
});
