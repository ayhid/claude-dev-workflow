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

import { DEFAULT_DOC_SET } from './docset.mjs';
import { DEFAULT_MAX_CHARS, mergeForDisplay } from './notes.mjs';

/** Every field has a working default except baseUrl, which has none. */
export const DEFAULTS = {
  /**
   * Which tracker this project uses. `youtrack` keeps every existing config
   * working untouched.
   *
   * A `github` project must additionally set `github.repo` and a
   * `github.labels` mapping, and declare an explicit `states.ladder` whose
   * first entry is what an issue with no ladder label means. The adapter
   * refuses to start without them rather than inventing a mapping — see
   * lib/provider.mjs rule 2.
   */
  provider: 'youtrack',
  github: {
    repo: null,
    /** Which repo holds the issues, when a project spans several. */
    issuesRepo: null,
    /** rung -> label name. Required for every rung except the first. */
    labels: {},
  },
  baseUrl: null,
  project: null,
  projectId: null,
  tokenOpRef: null,
  language: 'English',
  states: {
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
    /**
     * Where `dev.mjs abandon` puts a ticket whose work is being thrown away.
     *
     * No default, and deliberately no fallback to the first ladder rung: a
     * project that configures no ladder gets the derived `[start, review, done]`
     * one, whose first entry is *In Progress*. Walking a ticket back to the
     * state it is already in, silently, is exactly the kind of usually-right
     * guess rule 2 exists to refuse. Unset means `abandon` says which key to add.
     */
    abandon: null,
    ladder: [],
  },
  /**
   * How a ticket becomes a working copy.
   *
   * `pattern` tokens are `<type>`, `<ID>` and `<slug>`; a token the pattern
   * omits is never rendered, so a project pinning the pre-gitflow `<ID>-<slug>`
   * keeps the names it always had.
   *
   * `types` maps an **issue** type onto a **branch** type, and every value must
   * be one of `commit.types` — one vocabulary for the branch and the commits on
   * it, which is the only way the two cannot drift.
   *
   * `mode: worktree` checks the ticket out under `worktreeDir` instead of
   * switching the main checkout, so starting a ticket never disturbs work in
   * progress. `worktreeDir` is relative to the repo: a worktree inside the
   * project root still resolves this config through the normal upward walk.
   */
  branch: {
    pattern: '<type>/<ID>-<slug>',
    base: 'main',
    mode: 'worktree',
    worktreeDir: '.worktrees',
    types: { Bug: 'fix', Feature: 'feat', Task: 'chore', Epic: 'feat', Improvement: 'refactor' },
    fallbackType: 'chore',
  },
  /**
   * How finished work reaches the branch it is delivered onto.
   *
   * `pr` opens a pull request and lets the reconciler move the ticket to the
   * review rung. `direct` rebases, fast-forwards the target and pushes — which
   * is what a solo project wants, and what no amount of PR ceremony improves.
   *
   * `base` is the branch work is delivered **onto**, which is not the same
   * question as `branch.base` — the branch work is forked **from**. They are
   * equal in most projects, and `base: null` means exactly that: fall back to
   * `branch.base` so an existing config keeps behaving as it always did. They
   * come apart the moment a project forks from `main` but merges into
   * `develop`, or pins delivery to `release/2.x` while a release is being cut.
   * One key served both roles until #6, so neither could be said on its own.
   *
   * This is a property of the repository, not of the issue tracker, so it never
   * belongs in a provider capability. `repos[].delivery` overrides it per repo.
   */
  delivery: {
    mode: 'pr',
    base: null,
    remote: 'origin',
    push: true,
    cleanup: true,
  },
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

  /**
   * Where `dev.mjs note` writes durable project knowledge.
   *
   * Beside `.dev-workflow.json` rather than inside `_dev-workflow/`: that tree is
   * installer-managed and reported as drift when it is edited, which is exactly
   * wrong for a file whose whole purpose is to accumulate a team's own prose.
   * It is meant to be committed, and it holds no secret.
   */
  notesFile: '.dev-workflow.notes.md',
  notes: null,
  notesMaxChars: 4000,

  /**
   * One JSONL line per ticket transition, appended locally and sent nowhere.
   *
   * On by default: a measurement nobody switches on measures nothing, and this
   * writes one line per `start`, `done` or `abandon` to a file that holds no
   * secret. `metrics: false` turns it off entirely.
   *
   * Beside `.dev-workflow.json` rather than inside `_dev-workflow/`, for the
   * same reason the notes file is: that tree is installer-managed and reported
   * as drift when it changes. Unlike the notes file this one is **not** meant to
   * be committed — every developer appends to it, and a shared append-only log
   * conflicts on every merge. The first write says so rather than editing
   * anyone's `.gitignore`, which is not ours to write.
   */
  metrics: true,
  metricsFile: '.dev-workflow.metrics.jsonl',

  /**
   * `greenfield` or `brownfield`, settled once by a human.
   *
   * `dev.mjs assess` proposes it from signals and never writes it: a wrong
   * stage sends `/dev-init` down the wrong branch and nothing downstream would
   * notice, so it is confirmed rather than inferred (rule 2). Null means nobody
   * has decided, which is different from either answer.
   */
  stage: null,

  /**
   * Where architecture decision records live, relative to the project root.
   *
   * A default rather than a required key, which looks like a breach of rule 2
   * until you ask what a wrong value costs. `github.labels` is required because
   * a wrong mapping fails *silently* — the ticket simply never moves. A wrong
   * directory here is visible on the first `adr new`, in its output, naming the
   * path it wrote to. The convention is also near-universal (`docs/decisions`
   * is what MADR and `adr-tools` both use), so requiring it would make every
   * project restate the same answer for no protection.
   *
   * A monorepo that wants decisions per package points this somewhere else.
   *
   * `dir` is where the documentation skeleton is written, and `set` is which of
   * the catalogue's documents this project wants. `set` is an **array** on
   * purpose: `deepMerge` above replaces arrays outright, so a project listing
   * three targets gets exactly three. As an object it would get those three
   * plus the five defaults, silently.
   *
   * The default set is imported rather than restated — `lib/docset.mjs` is the
   * one place the document names exist as a list, for the same reason
   * `branch.types` maps onto `commit.types` instead of repeating it.
   */
  docs: { dir: 'docs', decisionsDir: 'docs/decisions', set: DEFAULT_DOC_SET },

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
export function formatConfig(config, file, notesFileContent = null) {
  const L = [];
  const push = (label, value) => L.push(`${label.padEnd(13)}${value}`);

  L.push(`config file: ${file ?? '<none — using defaults>'}`);
  push('provider:', config.provider ?? 'youtrack');

  // Where the issues live is provider-specific: a YouTrack instance URL means
  // nothing to a GitHub project, and printing `MISSING` for it would send
  // someone to /dev-init to fix a field they must not set.
  if ((config.provider ?? 'youtrack') === 'github') {
    const gh = config.github ?? {};
    push('repo:', gh.issuesRepo || gh.repo || 'MISSING — run /dev-init');
    if (gh.issuesRepo && gh.repo && gh.issuesRepo !== gh.repo) push('code repo:', gh.repo);
  } else {
    push('instance:', config.baseUrl ?? 'MISSING — run /dev-init');
    push('project:', config.project ?? 'MISSING — run /dev-init');
  }
  push('language:', config.language);
  push(
    'states:',
    `start=${config.states.start}  review=${config.states.review}  done=${config.states.done}` +
      // Only when set: printing `abandon=null` for every project that has never
      // needed the verb would read as a misconfiguration rather than an unused
      // feature. `dev.mjs abandon` names the key itself when it is missing.
      (config.states.abandon ? `  abandon=${config.states.abandon}` : ''),
  );
  if (config.states.ladder?.length) L.push(`             ladder: ${config.states.ladder.join(' → ')}`);
  push('branch:', `${config.branch.pattern}  (base: ${config.branch.base})`);
  // The isolation mode decides which directory every later command runs in, and
  // the delivery mode decides whether /dev-done opens a PR or lands the work.
  // Both are read straight off this output by the skills, so both must be here.
  const mode = config.branch.mode ?? 'worktree';
  L.push(
    `             mode: ${mode}${mode === 'worktree' ? ` (${config.branch.worktreeDir ?? '.worktrees'}/)` : ''}`,
  );
  const types = Object.entries(config.branch.types ?? {});
  if (types.length) {
    L.push(`             types: ${types.map(([k, v]) => `${k}→${v}`).join('  ')}`);
  }
  const d = config.delivery ?? {};
  // The target is the fork point until a project says otherwise, so naming it
  // unconditionally would print "→ main" for every config that has never heard
  // of `delivery.base`. It is called out only when the two genuinely differ —
  // which is the case where reading one and assuming the other loses work.
  const target = deliveryBase(config, d);
  const forkedElsewhere = target !== (config.branch.base ?? DEFAULTS.branch.base);
  push(
    'delivery:',
    d.mode === 'direct'
      ? `direct — rebase, fast-forward ${target}, ${d.push === false ? 'no push' : `push to ${d.remote ?? 'origin'}`}`
      : `pull request${forkedElsewhere ? ` → ${target}` : ''}`,
  );
  if (forkedElsewhere) {
    L.push(`             onto: ${target}  (forked from ${config.branch.base})`);
  }
  // The escape's scope is what means "no issue"; any configured type may wear
  // it. Rendering only the configured literal made that look type-pinned, and a
  // reader would never guess `feat(no-ticket):` is allowed too.
  const escapeScope = config.commit.noTicketEscape.match(/\(([^)]+)\)$/)?.[1];
  const escape = escapeScope
    ? `<type>(${escapeScope}): …`
    : `${config.commit.noTicketEscape}: …`;
  push('commit:', `${config.commit.pattern}   escape: ${escape}`);
  L.push(`  types:     ${config.commit.types.join(', ')}`);
  if (config.commit.scopes?.length) L.push(`  scopes:    ${config.commit.scopes.join(', ')}`);
  push('reviewer:', config.reviewer ?? '(none configured)');
  // Where the transition log goes, or that there is not one. A session that
  // cannot see this has no way to know whether its closes are being measured.
  // Only when settled. A project that has never been assessed should read as
  // undecided, not as greenfield.
  if (config.stage) push('stage:', config.stage);
  push(
    'metrics:',
    config.metrics === false
      ? 'off'
      : `${config.metricsFile ?? '.dev-workflow.metrics.jsonl'}  (local, never sent anywhere)`,
  );

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

  // Two sources on purpose. The inline array is what every project configured
  // before `dev.mjs note` existed already has, and it is never migrated or
  // rewritten; the file is what the command appends to. Both print, inline
  // first, so upgrading changes nothing about what a session already sees.
  //
  // `notesFileContent` is passed in rather than read here: this function is pure
  // and is called from tests with no filesystem. The caller does the IO.
  L.push('', 'notes:');
  const { lines } = mergeForDisplay({
    inline: config.notes,
    file: notesFileContent,
    path: config.notesFile,
    maxChars: config.notesMaxChars ?? DEFAULT_MAX_CHARS,
  });
  L.push(...lines);

  return L.join('\n');
}

/**
 * The rungs a caller may name instead of a state.
 *
 * `abandon` is here rather than only in `abandon.mjs` because the vocabulary has
 * exactly one home: `dev.mjs update <ID> state abandon` has to mean the same
 * thing as the verb does, and a second list is how the two would drift.
 */
export const RUNGS = ['start', 'review', 'done', 'abandon'];

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
  if (RUNGS.includes(rung)) {
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

/**
 * The branch type for an issue type.
 *
 * Two failures, both named after the key to add, because a guess here is worse
 * than an error: a branch called `feat/` for a hotfix is wrong in a way nobody
 * notices until the release notes are written (lib/provider.mjs rule 2).
 *
 * An issue with no type at all falls back to `branch.fallbackType` — that is a
 * configured decision, not an inference. An issue whose type is simply unmapped
 * is an error: the project declared its types, and this one is missing.
 *
 * @returns {{ok: true, type: string} | {ok: false, error: string}}
 */
export function resolveBranchType(config, issueType) {
  const map = config?.branch?.types ?? {};
  const commitTypes = config?.commit?.types ?? [];

  let type;
  if (!issueType) {
    type = config?.branch?.fallbackType;
    if (!type) {
      return {
        ok: false,
        error: 'the issue carries no type and no branch.fallbackType is set — set branch.fallbackType',
      };
    }
  } else {
    type = map[issueType];
    if (!type) {
      const known = Object.keys(map);
      return {
        ok: false,
        error:
          `no branch type mapped for issue type "${issueType}" — set branch.types["${issueType}"]` +
          (known.length ? ` (mapped so far: ${known.join(', ')})` : ''),
      };
    }
  }

  // One vocabulary. A branch type that is not a commit type means the branch
  // says `feature/` while every commit on it must say `feat` — which is the
  // drift this mapping exists to prevent.
  if (commitTypes.length && !commitTypes.includes(type)) {
    return {
      ok: false,
      error:
        `branch type "${type}" is not one of commit.types (${commitTypes.join(', ')}) — ` +
        'add it there, or map the issue type to a type that is',
    };
  }

  return { ok: true, type };
}

/**
 * The delivery settings for one repo: `repos[].delivery` over the top-level
 * block, the same way a repo already overrides its checks and remotes.
 *
 * A monorepo can genuinely want both — a library pushed straight to main and an
 * app that must go through review — so the override is per repo, not per project.
 */
export function deliveryFor(config, repoPath) {
  const base = config?.delivery ?? {};
  const repo = config?.repos?.find((r) => r.path === repoPath);
  return { ...DEFAULTS.delivery, ...base, ...(repo?.delivery ?? {}) };
}

/**
 * The branch finished work is delivered **onto** — the `direct` fast-forward
 * target, and the `--base` a pull request opens against.
 *
 * `delivery.base` when set, `branch.base` otherwise. The fallback is the whole
 * point: a config written before this key existed resolves to the branch it
 * always used, so nothing moves under anyone. Pass the result of `deliveryFor`
 * to get the per-repo override; the argument is required precisely so a caller
 * cannot read the top-level block and quietly ignore a repo's own setting.
 *
 * `land.mjs` and `describe` both need this answer, and computing the fallback
 * twice is how the two would eventually disagree about where work lands.
 */
export function deliveryBase(config, delivery) {
  return delivery?.base ?? config?.branch?.base ?? DEFAULTS.branch.base;
}
