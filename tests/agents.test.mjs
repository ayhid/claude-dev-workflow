/**
 * The shipped subagent definitions: one file per agent under agents/, installed
 * to .claude/agents/dev-<name>.md. Each pins a model and a tool allowlist, and
 * its body keeps the invariant rules ahead of the per-dispatch material, so
 * repeated dispatches share a cached prefix.
 *
 * And the skills that dispatch them may only name agents that exist: a skill
 * naming an agent that does not ship falls back to whatever the session runs
 * on, silently, which is the cost the definitions exist to avoid.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AGENT_PREFIX, parseAgent } from '../bin/lib/agents.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const AGENTS = join(ROOT, 'agents');
const MODELS = ['haiku', 'sonnet', 'opus', 'inherit'];

const agentFiles = () => readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort();

test('parseAgent reads frontmatter and body, and refuses a file without either', () => {
  const ok = parseAgent('---\nname: dev-x\ndescription: d\nmodel: haiku\ntools: Read, Grep\n---\n\n# Rules\n\ntext\n');
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.agent, { name: 'dev-x', description: 'd', model: 'haiku', tools: ['Read', 'Grep'], body: '# Rules\n\ntext\n' });
  assert.equal(parseAgent('# no frontmatter\n').ok, false);
  assert.equal(parseAgent('---\nname: dev-x\n---\n').ok, false, 'a body is required');
});

test('every shipped agent is namespaced, names itself, pins a model and allowlists its tools', () => {
  const files = agentFiles();
  assert.ok(files.length >= 4, 'dev-reader and the three review lenses');
  for (const file of files) {
    assert.ok(file.startsWith(AGENT_PREFIX), `${file} must carry the ${AGENT_PREFIX} prefix`);
    const parsed = parseAgent(readFileSync(join(AGENTS, file), 'utf8'));
    assert.equal(parsed.ok, true, `${file}: ${parsed.error}`);
    const { agent } = parsed;
    assert.equal(agent.name, file.replace(/\.md$/, ''), `${file}: name must equal the filename stem`);
    assert.ok(MODELS.includes(agent.model), `${file}: model "${agent.model}" is not one of ${MODELS.join(', ')}`);
    assert.ok(agent.tools.length > 0, `${file}: an agent allowlists its tools`);
    assert.ok(agent.description.length > 20, `${file}: the description is what the dispatcher reads`);
  }
});

test('the rules come first and the per-dispatch input last, so the prefix caches', () => {
  for (const file of agentFiles()) {
    const { agent } = parseAgent(readFileSync(join(AGENTS, file), 'utf8'));
    const rules = agent.body.indexOf('## ');
    const input = agent.body.indexOf('## Input');
    assert.ok(input !== -1, `${file}: says what arrives per dispatch under "## Input"`);
    assert.ok(rules < input, `${file}: the rules sit above the input section`);
    assert.equal(agent.body.slice(input).split('## ').length, 2, `${file}: "## Input" is the last section`);
  }
});

const REVIEW_LENSES = ['blind', 'edge', 'audit'];

test('the models match the task class: a reader is cheap, a review lens judges', () => {
  const model = (name) => parseAgent(readFileSync(join(AGENTS, `${name}.md`), 'utf8')).agent.model;
  assert.equal(model('dev-reader'), 'haiku');
  for (const lens of REVIEW_LENSES) assert.equal(model(`dev-review-${lens}`), 'sonnet', lens);
});

test('each review lens is its own agent: it names its lens file, which ships, and may only Read', () => {
  for (const lens of REVIEW_LENSES) {
    const { agent } = parseAgent(readFileSync(join(AGENTS, `dev-review-${lens}.md`), 'utf8'));
    const lensPath = `.claude/skills/dev-review/lenses/${lens}.md`;
    assert.ok(agent.body.includes(lensPath), `dev-review-${lens} reads its lens from ${lensPath}`);
    assert.ok(existsSync(join(ROOT, 'skills', 'dev-review', 'lenses', `${lens}.md`)), `${lens}.md ships with the skill`);
    assert.deepEqual(agent.tools, ['Read'], `dev-review-${lens} reads payload files and nothing more`);
    assert.match(agent.body, new RegExp(`"lens": "${lens}"`), 'reports which lens it is');
  }
  // What each lens may open is the whole design: blind sees only the diff.
  const body = (lens) => parseAgent(readFileSync(join(AGENTS, `dev-review-${lens}.md`), 'utf8')).agent.body;
  assert.doesNotMatch(body('blind').split('## Input')[1], /intent\.md|context\.txt/);
  assert.doesNotMatch(body('edge').split('## Input')[1], /intent\.md/);
  assert.match(body('audit').split('## Input')[1], /intent\.md/);
});

test('every dev-* name a skill mentions is a skill or an agent that ships', () => {
  const shippedAgents = new Set(agentFiles().map((f) => f.replace(/\.md$/, '')));
  const skills = join(ROOT, 'skills');
  const shippedSkills = new Set(readdirSync(skills));
  const named = new Map();
  for (const skill of shippedSkills) {
    const text = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8');
    for (const m of text.matchAll(/`(dev-[a-z][a-z-]*)`/g)) if (!shippedSkills.has(m[1])) named.set(m[1], skill);
  }
  for (const [name, skill] of named) assert.ok(shippedAgents.has(name), `${skill} names ${name}, which is neither a skill nor a shipped agent`);
  assert.equal(named.get('dev-reader'), 'dev-ingest-docs');
  for (const lens of REVIEW_LENSES) assert.equal(named.get(`dev-review-${lens}`), 'dev-review');
});
