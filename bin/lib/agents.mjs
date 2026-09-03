/**
 * Subagent definitions, as the installer and its tests read them.
 *
 * A definition is Markdown with YAML-ish frontmatter — `name`, `description`,
 * `model`, `tools` — and a body that is the agent's system prompt. Claude Code
 * reads the frontmatter; this parser exists so a shipped agent can be checked
 * before it ships: that it names itself after its file, pins a model from the
 * accepted set, allowlists its tools, and keeps its rules ahead of the input
 * it receives per dispatch. Deliberately narrow, refusing what it cannot read,
 * for the reason lib/architecture.mjs gives.
 */
export { AGENT_PREFIX } from './payload.mjs';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * @returns {{ok: true, agent: {name: string, description: string, model: string, tools: string[], body: string}} | {ok: false, error: string}}
 */
export function parseAgent(text) {
  const m = String(text ?? '').match(FRONTMATTER);
  if (!m) return { ok: false, error: 'no frontmatter block' };
  const fields = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) return { ok: false, error: `unreadable frontmatter line: ${line}` };
    fields[kv[1]] = kv[2].trim();
  }
  const body = m[2].replace(/^\n+/, '');
  if (!body.trim()) return { ok: false, error: 'an agent needs a body — its system prompt' };
  const tools = (fields.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return {
    ok: true,
    agent: { name: fields.name ?? '', description: fields.description ?? '', model: fields.model ?? '', tools, body },
  };
}
