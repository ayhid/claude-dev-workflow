/**
 * The README's account of what an install writes is checked against what the
 * tarball actually ships.
 *
 * Two facts in the README are counts of something that lives in a directory
 * listing: how many skills there are, and which skill and agent files land in
 * `.claude/`. Both went stale the same way, twice — a skill or an agent was
 * added, the tree was not — and nothing noticed until a reader did. The
 * listing is the source; the prose has to follow it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

const skills = readdirSync(join(ROOT, 'skills')).filter((d) => d.startsWith('dev-')).sort();
const agents = readdirSync(join(ROOT, 'agents')).filter((f) => /^dev-.*\.md$/.test(f)).sort();

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];

test('every count of skills in the README is the number of skills shipped', () => {
  const counts = [...README.matchAll(/\b(\w+) (?:Claude Code )?skills\b/g)]
    .map((m) => m[1].toLowerCase())
    .filter((w) => WORDS.includes(w));
  assert.ok(counts.length >= 2, 'the README states the skill count at least twice');
  for (const word of counts) {
    assert.equal(word, WORDS[skills.length], `README says "${word} skills"; skills/ has ${skills.length}`);
  }
});

test('the "What lands in the project" tree lists every skill and every agent shipped', () => {
  const start = README.indexOf('### What lands in the project');
  assert.ok(start > -1, 'README has a "What lands in the project" section');
  const fence = README.indexOf('```', start);
  const tree = README.slice(fence, README.indexOf('```', fence + 3));

  for (const skill of skills) {
    assert.ok(tree.includes(skill), `tree omits skill ${skill}`);
  }
  for (const agent of agents) {
    assert.ok(tree.includes(agent), `tree omits agent ${agent}`);
  }
  assert.ok(/agents\//.test(tree), 'tree names the .claude/agents/ root');
});
