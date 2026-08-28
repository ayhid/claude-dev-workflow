/**
 * The greenfield/brownfield verdict.
 *
 * The rule under test is that **what makes a project brownfield is that there
 * is already something here** — code, or documentation describing it. History
 * is evidence of activity, never of code, and the first test is the case that
 * proves it: `git init` on a codebase somebody has been building for years
 * produces one commit, one author and an age of zero.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessStage, describeStage, THRESHOLDS } from '../lib/stage.mjs';

const empty = { commits: 0, ageDays: 0, contributors: 0, sourceFiles: 0, sourceBytes: 0, docBytes: 0 };

test('a codebase imported into a fresh repo is brownfield, whatever its history says', () => {
  // The case this rule exists for, and not an edge case: it is how most
  // existing projects arrive at version control. Every history signal says
  // greenfield and is not consulted.
  const imported = {
    commits: 1,
    ageDays: 0,
    contributors: 1,
    sourceFiles: 400,
    sourceBytes: 3_000_000,
    docBytes: 0,
  };

  const out = assessStage(imported);
  assert.equal(out.verdict, 'brownfield');
  assert.equal(out.confidence, 'high');
  assert.match(out.why, /already a codebase here/);

  for (const name of ['commits', 'age', 'contributors']) {
    const r = out.rows.find((x) => x.name === name);
    assert.equal(r.points, 'greenfield', `${name} does say greenfield`);
    assert.equal(r.weight, 'corroborating', 'and it is not allowed to decide');
  }
});

test('a long history with nothing in it is still greenfield', () => {
  // The mirror image. Thousands of commits over years, but no source and no
  // documentation: there is nothing to survey, which is the question being
  // asked. History cannot make a project brownfield on its own either.
  const out = assessStage({ ...empty, commits: 5000, ageDays: 3000, contributors: 40 });
  assert.equal(out.verdict, 'greenfield');
  assert.equal(out.confidence, 'high');
  assert.match(out.why, /nothing has been built yet/);
});

test('a genuinely empty repo is greenfield', () => {
  const out = assessStage(empty);
  assert.equal(out.verdict, 'greenfield');
  assert.equal(out.confidence, 'high');
});

test('size decides when the file count does not', () => {
  // Ten files and two megabytes: an imported client, a vendored library, a
  // monolith nobody has split up. Counting files alone would miss it.
  const out = assessStage({ ...empty, sourceFiles: 10, sourceBytes: 2_000_000 });
  assert.equal(out.verdict, 'brownfield');
  assert.equal(out.confidence, 'high');
  assert.match(out.why, /of source/);
});

test('documentation alone is enough — there is still something to absorb', () => {
  const out = assessStage({ ...empty, sourceFiles: 2, docBytes: 80_000 });
  assert.equal(out.verdict, 'brownfield');
  assert.match(out.why, /existing documentation to absorb/);
});

// --- the narrow band ------------------------------------------------------------

test('a fresh scaffold is greenfield: some files, no history', () => {
  // `create-react-app` and friends: a dozen small files that are nobody's work.
  const out = assessStage({
    commits: 2, ageDays: 0, contributors: 1, sourceFiles: 12, sourceBytes: 9_000, docBytes: 500,
  });
  assert.equal(out.verdict, 'greenfield');
  assert.equal(out.confidence, 'mixed', 'this is the band where it could be either');
  assert.match(out.why, /scaffolding/);
});

test('the same file count with real history is brownfield', () => {
  // A small service somebody has maintained for two years. Identical by file
  // count to the scaffold above, and this is the only place history is allowed
  // to break the tie.
  const out = assessStage({
    commits: 600, ageDays: 700, contributors: 8, sourceFiles: 12, sourceBytes: 9_000, docBytes: 500,
  });
  assert.equal(out.verdict, 'brownfield');
  assert.equal(out.confidence, 'mixed');
  assert.match(out.why, /history signals say it has been worked on/);
});

// --- abstaining -------------------------------------------------------------------

test('a signal that could not be measured abstains rather than scoring zero', () => {
  const out = assessStage({ ...empty, sourceFiles: 400, sourceBytes: 3_000_000, commits: null, ageDays: null });
  assert.equal(out.verdict, 'brownfield', 'the decisive signals still settle it');
  assert.equal(out.rows.find((r) => r.name === 'commits').points, null);
  assert.match(out.rows.find((r) => r.name === 'commits').why, /not measured/);
});

test('nothing measurable at all is unclear, not a guess', () => {
  const out = assessStage({});
  assert.equal(out.verdict, 'unclear');
  assert.equal(out.confidence, 'none');
  assert.match(out.why, /is this a git repository/);
});

test('the threshold is on the brownfield side of the boundary', () => {
  const at = assessStage({ ...empty, sourceFiles: THRESHOLDS.sourceFiles });
  assert.equal(at.verdict, 'brownfield');
  const under = assessStage({ ...empty, sourceFiles: THRESHOLDS.sourceFiles - 1 });
  assert.equal(under.verdict, 'greenfield', 'one file below, and history has nothing to add');
});

// --- the report ---------------------------------------------------------------------

test('the report separates what decided from what merely agreed', () => {
  const out = describeStage(
    assessStage({ commits: 1, ageDays: 0, contributors: 1, sourceFiles: 400, sourceBytes: 3_000_000, docBytes: 0 }),
    { agentFiles: ['CLAUDE.md'], tests: true, ci: false },
  ).join('\n');

  assert.match(out, /stage: +brownfield/);
  assert.match(out, /is there a system here/);
  assert.match(out, /has it been worked on/);
  // A reader who disagrees with the verdict must be able to see which number
  // produced it, rather than six weighted equally.
  assert.ok(out.indexOf('is there a system here') < out.indexOf('has it been worked on'));
  assert.match(out, /source files +400 tracked source files/);
  assert.match(out, /agent docs +CLAUDE\.md/);
  assert.match(out, /proposal, not a finding/, 'a confident verdict must still be confirmed');
});
