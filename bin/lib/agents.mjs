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
import { parseFrontmatter } from '../../lib/issuetemplate.mjs';

export { AGENT_PREFIX } from './payload.mjs';

/**
 * The frontmatter reader lives in lib/issuetemplate.mjs — the payload needs
 * one for issue templates, and two readers of one format is the drift this
 * repo refuses. This stays stricter than that reader on purpose: a line it
 * cannot read is a refusal here, since a shipped agent is checked, not merely
 * consumed.
 *
 * @returns {{ok: true, agent: {name: string, description: string, model: string, tools: string[], body: string}} | {ok: false, error: string}}
 */
export function parseAgent(text) {
  const { fields, body, raw } = parseFrontmatter(text);
  if (raw === null) return { ok: false, error: 'no frontmatter block' };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (!/^([A-Za-z_-]+):\s*(.*)$/.test(line)) return { ok: false, error: `unreadable frontmatter line: ${line}` };
  }
  if (!body.trim()) return { ok: false, error: 'an agent needs a body — its system prompt' };
  const tools = (fields.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return {
    ok: true,
    agent: { name: fields.name ?? '', description: fields.description ?? '', model: fields.model ?? '', tools, body },
  };
}
