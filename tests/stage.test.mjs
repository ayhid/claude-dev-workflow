/**
 * The greenfield/brownfield verdict.
 *
 * Pure, and the point of the tests is the shape of the *reasoning*, not the
 * thresholds: a verdict nobody can argue with is a verdict nobody will confirm,
 * and this one is only ever a proposal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessStage, describeStage, THRESHOLDS } from '../lib/stage.mjs';

const mature = {
  commits: 900,
  ageDays: 700,
  contributors: 12,
  sourceFiles: 400,
  docBytes: 90_000,
};
const fresh = { commits: 3, ageDays: 1, contributors: 1, sourceFiles: 4, docBytes: 200 };

test('an old, busy, documented repo is brownfield with every signal agreeing', () => {
  const out = assessStage(mature);
  assert.equal(out.verdict, 'brownfield');
  assert.equal(out.confidence, 'high');
  assert.match(out.why, /5 of 5/);
});

test('a repo three commits old is greenfield', () => {
  const out = assessStage(fresh);
  assert.equal(out.verdict, 'greenfield');
  assert.equal(out.confidence, 'high');
});

test('a young but dense repo is brownfield, and says which signal dissented', () => {
  // The real case this exists for: a fortnight old, but 900 commits and 60k of
  // docs. Age says greenfield and is outvoted, and the tally shows it.
  const out = assessStage({ ...mature, ageDays: 13 });
  assert.equal(out.verdict, 'brownfield');
  assert.equal(out.confidence, 'mixed', 'not every signal agreed, and that must show');
  assert.equal(out.votes.find((v) => v.name === 'age').points, 'greenfield');
});

test('a signal that could not be measured abstains rather than scoring zero', () => {
  // "This repo has no history" and "git could not be read" are opposite
  // conclusions from the same missing number.
  const out = assessStage({ ...mature, commits: null, ageDays: null });
  assert.equal(out.verdict, 'brownfield', 'the three that were measured still decide');
  assert.equal(out.votes.find((v) => v.name === 'commits').points, null);
  assert.match(out.votes.find((v) => v.name === 'commits').why, /not measured/);
});

test('too little evidence is not a verdict', () => {
  const out = assessStage({ commits: 5, ageDays: 2 });
  assert.equal(out.verdict, 'unclear');
  assert.equal(out.confidence, 'none');
  assert.match(out.why, /only 2 signals/);
  assert.equal(assessStage({}).verdict, 'unclear', 'nothing measured at all');
});

test('an evenly split repo is unclear rather than rounded to a guess', () => {
  const out = assessStage({
    commits: THRESHOLDS.commits + 1,
    ageDays: THRESHOLDS.ageDays + 1,
    contributors: 1,
    sourceFiles: 1,
  });
  assert.equal(out.verdict, 'unclear');
  assert.match(out.why, /split 2–2/);
});

test('the threshold is on the brownfield side of the boundary', () => {
  const at = assessStage({ ...fresh, commits: THRESHOLDS.commits });
  assert.equal(at.votes.find((v) => v.name === 'commits').points, 'brownfield');
  const under = assessStage({ ...fresh, commits: THRESHOLDS.commits - 1 });
  assert.equal(under.votes.find((v) => v.name === 'commits').points, 'greenfield');
});

test('the report shows every vote and always ends by asking', () => {
  const out = describeStage(assessStage(mature), {
    agentFiles: ['CLAUDE.md'],
    tests: true,
    ci: false,
  }).join('\n');

  assert.match(out, /stage: +brownfield/);
  for (const name of ['commits', 'age', 'contributors', 'source files', 'documentation']) {
    assert.ok(out.includes(name), `${name} must be shown, not just counted`);
  }
  assert.match(out, /agent docs +CLAUDE\.md/);
  assert.match(out, /ci +none found/);
  assert.match(out, /proposal, not a finding/, 'a confident verdict must still be confirmed');
});
