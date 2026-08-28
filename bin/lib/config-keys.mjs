/**
 * Which settings `.dev-workflow.json` has, one entry at a time.
 *
 * `buildConfig` produces a whole config from a whole set of answers, which is
 * exactly what the wizard needs and no use at all to an *update*: "does this
 * project's file predate the key this version introduced?" is a question about
 * one key in isolation, and nothing could answer it. This registry is that
 * missing half — key, default, and the question to ask for it — and it is what
 * lets `--update` add a new setting without walking the wizard again.
 *
 * Nothing here prompts, reads a file or shells out, for the same reason
 * `wizard-config.mjs` does not: a script full of prompts cannot be run without a
 * TTY, so nothing could assert what it decided. The question is *described*
 * here and rendered by the caller.
 *
 * ## What belongs in this registry, and what must never
 *
 * Only keys `buildConfig` writes **unconditionally**. That is the whole
 * distinction the express path rests on: for such a key, absent means *this
 * config predates it*, and asking is not re-asking. For every key `buildConfig`
 * writes conditionally — `reviewer`, `repos`, `notes`, `issueTypes`,
 * `priorities`, `defaultPriority`, `branch.types`, `delivery.remote` — absent
 * means **answered, and answered blank**. Adding one of those here would
 * re-ask, every update, a question the user has already answered with silence.
 *
 * `states.abandon` is the sharpest case and is deliberately absent: it is the
 * one state with no default anywhere, because walking a ticket backwards is the
 * single move nothing downstream would notice was wrong. It is omitted from a
 * config precisely when the user chose None, and it must never gain a default
 * here.
 *
 * A key that cannot be answered *alone* does not belong either. `states.ladder`
 * on GitHub is the example: every rung but the first needs a label mapped onto
 * it, so a ladder answered by itself would leave `github.labels` describing the
 * old one. It carries an `appliesTo` for that, and the caller sends those
 * projects to the wizard instead.
 */
import { proposeProvider } from './wizard-config.mjs';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Split a dotted path, e.g. `states.start` → `['states', 'start']`. */
const parts = (key) => key.split('.');

/**
 * Is `key` present in `config` — as a key, whatever its value?
 *
 * Presence, not truthiness: `enforce: false` and `reviewer: ''` are answers.
 * An own-property check at every level, and a non-object on the way down means
 * the leaf cannot be there.
 */
export function hasConfigKey(config, key) {
  let node = config;
  for (const part of parts(key)) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return false;
    node = node[part];
  }
  return true;
}

/** The value at a dotted path, or `undefined`. */
export function getConfigKey(config, key) {
  let node = config;
  for (const part of parts(key)) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Write `value` at a dotted path, creating the objects on the way down.
 *
 * Mutates, and **appends**: a key added to an object that already exists lands
 * after the ones already in it, so nothing the user answered is reordered.
 * Never replaces an intermediate that is already an object.
 */
export function setConfigKey(config, key, value) {
  const path = parts(key);
  let node = config;
  for (const part of path.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part];
  }
  node[path.at(-1)] = value;
  return config;
}

const csv = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Every setting that can be added to an existing config on its own.
 *
 * Order matters: they are processed top to bottom and a `default` sees the
 * config as it stands, so `commit.pattern` can be derived from the
 * `commit.position` answered a moment earlier.
 *
 * Each entry is:
 *   key         dotted path into .dev-workflow.json
 *   message     the question, in the terms the wizard asks it in
 *   type        'select' | 'text' — how to render it
 *   options     for a select
 *   default     (config) => value, pure, and correct with no TTY to ask on
 *   render      value => string shown as a text prompt's initial value
 *   parse       string => value, for a text prompt whose answer is not a string
 *   appliesTo   (config) => boolean; omitted means every project
 */
export const CONFIG_KEYS = [
  {
    key: 'provider',
    message: 'Which issue tracker does this project use?',
    type: 'select',
    options: [
      { value: 'github', label: 'GitHub Issues' },
      { value: 'youtrack', label: 'YouTrack' },
    ],
    // The config outranks everything, and outranks it even when it predates the
    // key: a `baseUrl` is a YouTrack project however the code is hosted.
    default: (config) => proposeProvider({ existing: config }),
  },
  {
    key: 'language',
    message: 'Language for ticket prose',
    type: 'text',
    default: () => 'English',
  },
  {
    key: 'states.start',
    message: 'State meaning "started" (/dev-task moves here)',
    type: 'text',
    default: () => 'In Progress',
  },
  {
    key: 'states.review',
    message: 'State meaning "in review" (set when a PR opens)',
    type: 'text',
    default: () => 'In Review',
  },
  {
    key: 'states.done',
    message: 'State meaning "finished" (/dev-done moves here)',
    type: 'text',
    default: () => 'Done',
  },
  {
    key: 'states.ladder',
    message: 'The states this project moves through, first to last (comma-separated)',
    type: 'text',
    // On GitHub every rung but the first needs a label mapped onto it, and that
    // mapping is not answerable here — a ladder changed without its labels
    // leaves `github.labels` describing the old one.
    appliesTo: (config) => proposeProvider({ existing: config }) !== 'github',
    default: (config) => [
      ...new Set(
        ['states.start', 'states.review', 'states.done']
          .map((k) => getConfigKey(config, k))
          .filter(Boolean),
      ),
    ],
    render: (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? '')),
    parse: csv,
  },
  {
    key: 'branch.base',
    message: 'Branch that work is forked from',
    type: 'text',
    default: () => 'main',
  },
  {
    key: 'branch.mode',
    message: 'Where should starting a ticket check the code out?',
    type: 'select',
    options: [
      { value: 'worktree', label: 'A separate directory (git worktree)' },
      { value: 'branch', label: 'This checkout' },
    ],
    default: () => 'worktree',
  },
  {
    key: 'branch.pattern',
    message: 'How branches are named',
    type: 'select',
    options: [
      { value: '<type>/<ID>-<slug>', label: '<type>/<ID>-<slug>', hint: 'prefixed with the change type' },
      { value: '<ID>-<slug>', label: '<ID>-<slug>', hint: 'no type prefix' },
    ],
    // A branch carries a type only if the tracker can say what an issue's type
    // is. On GitHub that means type labels, which `github.labels.type` records;
    // without them every branch would render the `chore` fallback.
    default: (config) =>
      proposeProvider({ existing: config }) !== 'github' || getConfigKey(config, 'github.labels.type')
        ? '<type>/<ID>-<slug>'
        : '<ID>-<slug>',
  },
  {
    key: 'delivery.mode',
    message: 'How finished work reaches the base branch',
    type: 'select',
    options: [
      { value: 'pr', label: 'Open a pull request' },
      { value: 'direct', label: 'Rebase, fast-forward and push' },
    ],
    default: () => 'pr',
  },
  {
    key: 'commit.position',
    message: 'Where does the issue ID go in a commit subject?',
    type: 'select',
    options: [
      { value: 'suffix', label: 'Suffix', hint: 'feat(api): add thing (<ID>) — commitlint-safe' },
      { value: 'prefix', label: 'Prefix', hint: '<ID> feat(api): add thing' },
      { value: 'any', label: 'Anywhere', hint: 'only require that an ID appears' },
    ],
    default: () => 'suffix',
  },
  {
    key: 'commit.pattern',
    message: 'The commit subject a ticket-referencing commit must match',
    type: 'text',
    // Derived from the answer above rather than defaulted independently: a
    // `prefix` project handed the suffix pattern would be told its own commits
    // are malformed.
    default: (config) =>
      getConfigKey(config, 'commit.position') === 'prefix'
        ? '<ID> type(scope): description'
        : 'type(scope): description (<ID>)',
  },
  {
    key: 'commit.noTicketEscape',
    message: 'The escape hatch for work with no ticket behind it',
    type: 'text',
    default: () => 'chore(no-ticket)',
  },
];

/**
 * The settings this version knows about that `config` does not have.
 *
 * @param {object} config the parsed `.dev-workflow.json`
 * @returns {typeof CONFIG_KEYS} in registry order
 */
export function missingConfigKeys(config) {
  if (!isPlainObject(config)) return [];
  return CONFIG_KEYS.filter((entry) => (entry.appliesTo ? entry.appliesTo(config) : true)).filter(
    (entry) => !hasConfigKey(config, entry.key),
  );
}

/** What to write for a key nobody is there to ask about. */
export function defaultForKey(entry, config) {
  return entry.default(config);
}

/** One line of the report: what was added, and what it was set to. */
export function describeValue(value) {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
