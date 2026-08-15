/**
 * The one place that knows what `.youtrack.json` means.
 *
 * This replaces three copies of the same upward walk (yt-lib.sh, yt-config.sh,
 * check-commit-ticket.sh) and a hand-rolled recursive deep-merge written in jq.
 * The installer and the runtime scripts both read the config through here, so
 * the shape can no longer drift between them.
 *
 * Resolution order, lowest precedence first:
 *   1. the defaults below
 *   2. the nearest .youtrack.json (or .claude/youtrack.json), walking up
 *   3. environment variables
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Every field has a working default except baseUrl, which has none. */
export const DEFAULTS = {
  baseUrl: null,
  project: null,
  projectId: null,
  tokenOpRef: null,
  language: 'English',
  states: {
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
    ladder: [],
  },
  branch: { pattern: '<ID>-<slug>', base: 'main' },
  commit: {
    pattern: 'type(scope): description (<ID>)',
    position: 'suffix',
    noTicketEscape: 'chore(no-ticket)',
    types: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'revert', 'build'],
    scopes: [],
  },
  issueTypes: ['Bug', 'Feature', 'Task', 'Epic', 'Improvement'],
  priorities: ['Show-stopper', 'Critical', 'Major', 'Normal', 'Minor'],
  defaultPriority: 'Normal',
  reviewer: null,
  sync: { comment: 'PR {url} — {state}' },
  repos: [],
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Merge `patch` over `base`. Objects merge recursively; arrays and scalars are
 * replaced outright — a user listing three commit types means exactly those
 * three, not those three plus the eleven defaults.
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Config filenames, in precedence order, checked at each level of the walk.
 *
 * Precedence is per-directory, not per-name: the nearest directory holding
 * either of these wins, and within it the root file beats the `.claude/` one.
 *
 * `hooks/check-commit-ticket.sh` re-implements this walk in bash and must list
 * the same names in the same order — `tests/config.test.mjs` asserts the two
 * lists match, because this module exists precisely because three copies of
 * this walk had already drifted apart once.
 */
export const CONFIG_FILES = ['.dev-workflow.json', join('.claude', 'dev-workflow.json')];

/**
 * Nearest config file, walking up from `startDir`.
 * Returns null rather than throwing — running without one is legitimate.
 */
export function findConfigFile(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    for (const rel of CONFIG_FILES) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project root implied by a config file path. */
export function projectRootFor(configFile) {
  if (!configFile) return null;
  const dir = dirname(configFile);
  // .claude/dev-workflow.json sits one level below the root.
  return basename(dir) === '.claude' ? dirname(dir) : dir;
}

/**
 * Load the effective config.
 *
 * @param {{dir?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{config: object, file: string|null, root: string}}
 */
export function loadConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const startDir = opts.dir ?? env.YOUTRACK_CONFIG_DIR ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const file = findConfigFile(startDir);
  let user = {};
  if (file) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`cannot read ${file}: ${err.message}`);
    }
    try {
      user = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
    if (!isPlainObject(user)) throw new Error(`${file} must contain a JSON object`);
  }

  let config = deepMerge(DEFAULTS, user);

  // Environment always wins.
  const fromEnv = {
    baseUrl: env.YOUTRACK_BASE_URL,
    project: env.YOUTRACK_PROJECT,
    projectId: env.YOUTRACK_PROJECT_ID,
    tokenOpRef: env.YOUTRACK_TOKEN_OP_REF,
    language: env.YOUTRACK_LANGUAGE,
  };
  for (const [k, v] of Object.entries(fromEnv)) {
    if (v) config[k] = v;
  }

  if (config.baseUrl) config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');

  return { config, file, root: projectRootFor(file) ?? resolve(startDir) };
}

/**
 * The state ladder, falling back to start/review/done when none is configured.
 * `rank` is how sync decides whether a transition moves forward.
 */
export function ladderOf(config) {
  const ladder = config.states?.ladder ?? [];
  if (ladder.length > 0) return ladder;
  return [config.states.start, config.states.review, config.states.done];
}

/** Index of `state` on the ladder, or -1 when it is not on it at all. */
export function rankOf(config, state) {
  return ladderOf(config).indexOf(state);
}

/** The human-readable summary a skill reads in one call. */
export function formatConfig(config, file) {
  const L = [];
  const push = (label, value) => L.push(`${label.padEnd(13)}${value}`);

  L.push(`config file: ${file ?? '<none — using defaults>'}`);
  push('instance:', config.baseUrl ?? 'MISSING — run /dev-init');
  push('project:', config.project ?? 'MISSING — run /dev-init');
  push('language:', config.language);
  push(
    'states:',
    `start=${config.states.start}  review=${config.states.review}  done=${config.states.done}`,
  );
  if (config.states.ladder?.length) L.push(`             ladder: ${config.states.ladder.join(' → ')}`);
  push('branch:', `${config.branch.pattern}  (base: ${config.branch.base})`);
  push('commit:', `${config.commit.pattern}   escape: ${config.commit.noTicketEscape}: …`);
  L.push(`  types:     ${config.commit.types.join(', ')}`);
  if (config.commit.scopes?.length) L.push(`  scopes:    ${config.commit.scopes.join(', ')}`);
  push('reviewer:', config.reviewer ?? '(none configured)');

  L.push('', 'repos:');
  if (!config.repos?.length) {
    L.push('  (none configured — treat the project as a single repo at its root)');
  } else {
    for (const r of config.repos) {
      L.push(`  - ${r.path}`);
      if (r.when) L.push(`      routes: ${r.when}`);
      if (r.checks) L.push(`      checks: ${r.checks.join(' && ')}`);
      if (r.scopes) L.push(`      scopes: ${r.scopes.join(', ')}`);
      if (r.env) {
        L.push(`      env:    ${Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
      if (r.remotes) L.push(`      push:   ${r.remotes.join(', ')}`);
    }
  }

  L.push('', 'notes:');
  const notes = config.notes;
  if (!notes) L.push('  (none)');
  else for (const n of Array.isArray(notes) ? notes : [notes]) L.push(`  - ${n}`);

  return L.join('\n');
}

/**
 * Resolve a rung to the state name configured for it.
 *
 * `start` / `review` / `done` are the semantic rungs the skills speak. Anything
 * else must already be on the ladder — a literal that is not is a typo, and
 * catching it here makes the failure immediate and local instead of a write
 * that reports success and changes nothing.
 *
 * @returns {{ok: true, state: string} | {ok: false, error: string}}
 */
export function resolveRung(config, rung) {
  if (typeof rung !== 'string' || rung === '') {
    return { ok: false, error: 'no state given — expected start, review, done, or a ladder state' };
  }

  const named = config?.states?.[rung];
  if (rung === 'start' || rung === 'review' || rung === 'done') {
    if (!named) return { ok: false, error: `no state configured for "${rung}" — set states.${rung}` };
    return { ok: true, state: named };
  }

  const ladder = ladderOf(config);
  if (ladder.includes(rung)) return { ok: true, state: rung };

  return {
    ok: false,
    error: `"${rung}" is not on the ladder (${ladder.join(' → ')}) — use start, review, done, or one of those`,
  };
}
