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
import { readdirSync, readFileSync } from 'node:fs';
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
  assert.ok(files.length >= 2, 'at least dev-reader and dev-reviewer');
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

test('the models match the task class: a reader is cheap, a reviewer judges', () => {
  const model = (name) => parseAgent(readFileSync(join(AGENTS, `${name}.md`), 'utf8')).agent.model;
  assert.equal(model('dev-reader'), 'haiku');
  assert.equal(model('dev-reviewer'), 'sonnet');
});

test('every agent a skill dispatches by name ships', () => {
  const shipped = new Set(agentFiles().map((f) => f.replace(/\.md$/, '')));
  const skills = join(ROOT, 'skills');
  const named = new Map();
  for (const skill of readdirSync(skills)) {
    const text = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8');
    for (const m of text.matchAll(/`(dev-[a-z-]+)`\s+(?:agent|subagent)/g)) named.set(m[1], skill);
    for (const m of text.matchAll(/subagent_type:\s*`?(dev-[a-z-]+)`?/g)) named.set(m[1], skill);
  }
  for (const [name, skill] of named) assert.ok(shipped.has(name), `${skill} dispatches ${name}, which does not ship`);
  assert.equal(named.get('dev-reader'), 'dev-ingest-docs');
  assert.equal(named.get('dev-reviewer'), 'dev-review');
});
