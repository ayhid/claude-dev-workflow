/**
 * Which doctrine rules the project's linter already decides.
 *
 * The clean-code doctrine splits in two, and an A/B eval is what split it: the
 * rules a linter can decide scored the same with the doctrine in the prompt as
 * without it — the model already applies them — while the semantic ones carried
 * the entire gain. A mechanical rule therefore belongs in the project's
 * deterministic tooling, where a cheaper model gets it caught by the linter
 * rather than by the prompt landing.
 *
 * This file is the table that makes the split mechanical. `lib/rules.mjs`
 * answers *which linter is set up here, and how do I run one of its rules*;
 * this answers *which doctrine statement does which tool rule decide*. The
 * dependency runs one way — nothing in `rules.mjs` imports from here — so a
 * project that never asks for coverage gets the report it always got.
 *
 * Pure, with its reader injected (provider.mjs rule 1), and deterministic
 * (rule 4): the same project reports the same bytes twice.
 *
 * **On running the project's ESLint.** Coverage is decided by running
 * `eslint --print-config`, which executes `eslint.config.js` in the project's
 * own ESLint process — the same thing `countRecipe` already relies on and the
 * same thing the project's CI does. What we never do is `await import()` a
 * config into *this* process, where a module-scope side effect would run with
 * our privileges inside the session's lifetime. That is the line
 * `bin/lib/detect.mjs` draws when it greps a commitlint config rather than
 * importing it, and it is drawn in the same place here.
 */

/**
 * The tools a doctrine rule can be decided by, sorted.
 *
 * `typescriptEslint` is its own tool rather than a flavour of `eslint` because
 * its rules need a parser project to run at all: a project without one cannot
 * enable them, and conflating the two would hand it a suggestion it cannot
 * apply.
 */
export const DOCTRINE_TOOLS = ['biome', 'eslint', 'typescriptEslint'];

/** `eslint --print-config` names every rule it resolved, so the id is proved by its presence. */
const ESLINT_VERIFY = 'npx --no-install eslint --print-config <FILE>';
/** `biome explain` exits non-zero on a rule it does not know. */
const BIOME_VERIFY = 'npx --no-install biome explain <RULE>';

/**
 * The doctrine, rule by rule, with what decides each one.
 *
 * **The ids are owned here.** They are slugs invented for this table, never
 * derived from a heading, a line number or a bullet's position — all three move
 * the moment the doctrine's prose is edited, and the whole point of an id is to
 * survive that. `section` and `statement` carry the doctrine's own words so the
 * report is readable before the doctrine text ships anywhere.
 *
 * `level` is the eval's finding, made mechanical:
 *
 * - `lint`          a linter decides it, fully. The prompt need not teach it.
 * - `proxy`         a linter decides a measurable stand-in, not the rule. The
 *                   prompt still teaches it; the rule catches the clear cases.
 * - `doctrine-only` nothing mechanical comes close. Prompt or nothing.
 *
 * @typedef {object} ToolRule
 * @property {string} id        the rule in the tool's own vocabulary
 * @property {'error'|'warn'} severity  what the suggestion proposes
 * @property {unknown[]} options        what follows the severity, in the tool's own shape
 * @property {{numeric: string, compare: 'atMost'|'atLeast', bound: number}|null} threshold
 *           how to judge an existing configuration weaker than the suggestion.
 *           Generic on purpose: `numeric` names the option, which ESLint spells
 *           either positionally (`['warn', 2]`) or as a key (`['warn', {max: 2}]`)
 *           and `normaliseThreshold` reads both. A switch on rule id here would
 *           make every rule added later a code change instead of data.
 * @property {boolean} [recommended]  Biome only: is it in the recommended set
 * @property {'type-aware'} [requires]  needs parserOptions.project or projectService
 * @property {string} verify    proves the id exists in the installed version
 *
 * @typedef {object} DoctrineRule
 * @property {string} id
 * @property {string} section    where it comes from, in the doctrine's words
 * @property {string} statement  the doctrine sentence
 * @property {'lint'|'proxy'|'doctrine-only'} level
 * @property {string} why        why that level — printed, not a comment
 * @property {string} [caveat]   printed with the suggestion
 * @property {Record<string, ToolRule[]|null>} tools
 * @property {Record<string, string>} absent  a reason for every null above
 * @property {'all'|'any'} satisfiedBy
 * @property {boolean} [needsProjectInput]  emit a `<…>` template, never invent
 */
export const DOCTRINE_RULES = [
  {
    id: 'boolean-behaviour-params',
    section: '3. The call site is the interface',
    statement: 'No boolean parameters that select behaviour.',
    level: 'proxy',
    why:
      'the doctrine draws a line no AST can see — `render(true)` selects behaviour and is ' +
      'forbidden, `setVisible(false)` is plain data and is explicitly fine — and both are a ' +
      'boolean-typed parameter. A selector flags the smell, not the rule.',
    caveat: 'flags a boolean parameter that is plain data too, which the doctrine permits',
    satisfiedBy: 'all',
    tools: {
      biome: null,
      eslint: [
        {
          id: 'no-restricted-syntax',
          severity: 'warn',
          options: [
            {
              selector:
                ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSMethodSignature)' +
                ' > Identifier[typeAnnotation.typeAnnotation.type="TSBooleanKeyword"]',
              message: 'a boolean parameter hides a second function — split it, or pass a named option',
            },
          ],
          threshold: null,
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: null,
    },
    absent: {
      biome: 'biome has no arbitrary-AST-selector rule, so nothing there can express this',
      typescriptEslint: 'the selector is a core no-restricted-syntax one; no typed rule adds to it',
    },
  },
  {
    id: 'boolean-names-are-questions',
    section: '1. Names carry the meaning',
    statement: 'Booleans are yes/no questions — isFirstRun, hasExpired, canRetry.',
    level: 'lint',
    why: 'a boolean-typed name either carries one of a fixed set of prefixes or it does not',
    satisfiedBy: 'all',
    tools: {
      biome: null,
      eslint: null,
      typescriptEslint: [
        {
          id: '@typescript-eslint/naming-convention',
          severity: 'warn',
          // The prefix is stripped before the format is checked, which is why
          // PascalCase is right here: `isFirstRun` less `is` is `FirstRun`.
          options: [
            {
              selector: 'variable',
              types: ['boolean'],
              format: ['PascalCase'],
              prefix: ['is', 'has', 'can', 'should', 'was', 'did', 'will'],
            },
          ],
          threshold: null,
          requires: 'type-aware',
          verify: ESLINT_VERIFY,
        },
      ],
    },
    absent: {
      biome:
        'style/useNamingConvention decides casing only — it cannot require a prefix, which is ' +
        'the whole of this rule',
      eslint: 'core ESLint cannot see that a name is boolean-typed; this needs type information',
    },
  },
  {
    id: 'cleanup-symmetry',
    section: '6. State belongs to something that owns it',
    statement: 'Anything created must be able to be cleaned up.',
    level: 'doctrine-only',
    why:
      'no linter models the lifetime of a registration. The setup and the teardown are two ' +
      'unrelated statements to every rule engine, usually in different functions and often in ' +
      'different files, and nothing mechanical relates them.',
    satisfiedBy: 'all',
    tools: { biome: null, eslint: null, typescriptEslint: null },
    absent: {
      biome: 'no linter models the lifetime of a registration',
      eslint: 'no linter models the lifetime of a registration',
      typescriptEslint: 'no linter models the lifetime of a registration',
    },
  },
  {
    id: 'error-discipline',
    section: '7. Errors are for the unrecoverable',
    statement: 'Raise only when the program has reached a state it cannot continue from.',
    level: 'proxy',
    why:
      'whether a program can continue is a judgement. What a linter can decide is the ' +
      'mechanical half — a promise nobody awaited, a throw of something that is not an Error, ' +
      'a catch block that swallows.',
    satisfiedBy: 'all',
    tools: {
      biome: [
        {
          id: 'suspicious/noEmptyBlockStatements',
          severity: 'error',
          options: [],
          threshold: null,
          recommended: false,
          verify: BIOME_VERIFY,
        },
      ],
      eslint: [
        {
          id: 'no-empty',
          severity: 'error',
          options: [{ allowEmptyCatch: false }],
          threshold: null,
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: [
        {
          id: '@typescript-eslint/no-floating-promises',
          severity: 'error',
          options: [],
          threshold: null,
          requires: 'type-aware',
          verify: ESLINT_VERIFY,
        },
        {
          id: '@typescript-eslint/only-throw-error',
          severity: 'error',
          options: [],
          threshold: null,
          requires: 'type-aware',
          verify: ESLINT_VERIFY,
        },
      ],
    },
    absent: {},
  },
  {
    id: 'full-word-naming',
    section: '1. Names carry the meaning',
    statement: 'Whole English words, never abbreviations — player, not plr.',
    level: 'proxy',
    why:
      'no rule knows English. A length floor and a denylist of the abbreviations that actually ' +
      'recur catch the common cases and miss every novel one, which is what makes this a stand-in.',
    satisfiedBy: 'any',
    tools: {
      biome: null,
      eslint: [
        {
          id: 'id-length',
          severity: 'warn',
          options: [{ min: 3, exceptions: ['id', 'to', 'of', 'in', 'on', 'at', 'db', 'os', 'ok', '_'] }],
          threshold: { numeric: 'min', compare: 'atLeast', bound: 3 },
          verify: ESLINT_VERIFY,
        },
        {
          id: 'id-denylist',
          severity: 'warn',
          options: [
            'cfg', 'ctx', 'msg', 'req', 'res', 'err', 'tmp', 'val',
            'obj', 'arr', 'num', 'str', 'idx', 'el', 'btn', 'usr', 'cnt',
          ],
          threshold: null,
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: null,
    },
    absent: {
      biome: 'biome has no id-length or id-denylist equivalent',
      typescriptEslint: 'these are core ESLint rules; no typed rule adds to them',
    },
  },
  {
    id: 'injection-for-testability',
    section: '8. Be boring',
    statement: 'Untestable code is bad code — code that cannot be tested without standing up the world.',
    level: 'proxy',
    why:
      'testability is not decidable. What a project can decide is which modules its own core ' +
      'must not reach for directly — and only the project knows which those are.',
    needsProjectInput: true,
    satisfiedBy: 'any',
    tools: {
      biome: null,
      eslint: [
        {
          id: 'no-restricted-imports',
          severity: 'warn',
          options: [
            {
              paths: [
                {
                  name: '<the module this layer must not reach for directly>',
                  message: 'inject it instead, so this can be tested by calling it',
                },
              ],
            },
          ],
          threshold: null,
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: null,
    },
    absent: {
      biome:
        "biome's noRestrictedImports exists but its group has moved between releases; the " +
        'suggestion is made in ESLint, where the shape is stable',
      typescriptEslint: 'the core rule already covers it; the typed variant adds only type-only imports',
    },
  },
  {
    id: 'one-job-per-function',
    section: '5. One job per function, and few side effects',
    statement: 'A function that loads data and computes over it cannot be tested without a fixture.',
    level: 'proxy',
    why:
      'how many jobs a function has is a reading of it. Size and branch count are the measurable ' +
      'shadow — a function doing two jobs is usually long or branchy, and a short one rarely is.',
    satisfiedBy: 'any',
    tools: {
      biome: [
        {
          id: 'complexity/noExcessiveCognitiveComplexity',
          severity: 'warn',
          options: [],
          threshold: null,
          recommended: false,
          verify: BIOME_VERIFY,
        },
      ],
      eslint: [
        {
          id: 'complexity',
          severity: 'warn',
          options: [{ max: 8 }],
          threshold: { numeric: 'max', compare: 'atMost', bound: 8 },
          verify: ESLINT_VERIFY,
        },
        {
          id: 'max-lines-per-function',
          severity: 'warn',
          options: [{ max: 50, skipBlankLines: true, skipComments: true }],
          threshold: { numeric: 'max', compare: 'atMost', bound: 50 },
          verify: ESLINT_VERIFY,
        },
        {
          id: 'max-statements',
          severity: 'warn',
          options: [{ max: 15 }],
          threshold: { numeric: 'max', compare: 'atMost', bound: 15 },
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: null,
    },
    absent: { typescriptEslint: 'these are core ESLint rules; no typed rule adds to them' },
  },
  {
    id: 'options-objects',
    section: '3. The call site is the interface',
    statement: 'Take an options object as the last — or only — parameter, and let absence mean absence.',
    level: 'lint',
    why: 'a parameter count is exactly countable, and it is the thing the rule is about',
    satisfiedBy: 'all',
    tools: {
      biome: null,
      eslint: [
        {
          id: 'max-params',
          severity: 'warn',
          options: [{ max: 2 }],
          threshold: { numeric: 'max', compare: 'atMost', bound: 2 },
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: null,
    },
    absent: {
      biome: 'biome has no max-params equivalent',
      typescriptEslint: 'max-params is a core ESLint rule; no typed rule adds to it',
    },
  },
  {
    id: 'result-types',
    section: '7. Errors are for the unrecoverable',
    statement: 'Return a success value — a result type, a tuple, an option, whatever the language offers.',
    level: 'lint',
    why: 'a throw is a syntax node, and the rule is about whether there is one',
    caveat:
      'flags every throw, including the unrecoverable ones the doctrine permits — read the ' +
      'count before switching it on',
    satisfiedBy: 'all',
    tools: {
      biome: null,
      eslint: [
        {
          id: 'no-restricted-syntax',
          severity: 'warn',
          options: [
            {
              selector: 'ThrowStatement',
              message: 'return a result; throw only when the program cannot continue',
            },
          ],
          threshold: null,
          verify: ESLINT_VERIFY,
        },
      ],
      typescriptEslint: null,
    },
    absent: {
      biome: 'biome has no arbitrary-AST-selector rule, so nothing there can express this',
      typescriptEslint: 'the selector is a core no-restricted-syntax one; no typed rule adds to it',
    },
  },
];

/**
 * ESLint's severities, in both the spellings a resolved configuration uses.
 *
 * `--print-config` reports whatever the config said, and a config may say
 * either, so a reader that knows one of them calls half of all projects
 * unconfigured.
 */
const SEVERITY = { off: 0, 0: 0, warn: 1, 1: 1, error: 2, 2: 2 };

/** The severity of a resolved entry, or `null` when the shape is not one we know. */
function severityOf(entry) {
  const raw = Array.isArray(entry) ? entry[0] : entry;
  const level = SEVERITY[raw];
  return level === undefined ? null : level;
}

/**
 * The numeric bound a resolved entry sets, in either of ESLint's spellings.
 *
 * `['warn', 2]` and `['warn', {max: 2}]` are the same configuration. `null`
 * means the rule is on but said nothing about its bound, which leaves the
 * tool's own default in force — and that default is not knowable from here, so
 * it is reported as found-but-unmeasured rather than guessed at.
 */
export function normaliseThreshold(entry, numeric) {
  if (!Array.isArray(entry)) return null;
  for (const arg of entry.slice(1)) {
    if (typeof arg === 'number') return arg;
    if (arg && typeof arg === 'object' && typeof arg[numeric] === 'number') return arg[numeric];
  }
  return null;
}

/** Is a found bound weaker than the one the suggestion proposes? */
function isWeaker(found, threshold) {
  if (found === null || !threshold) return false;
  return threshold.compare === 'atMost' ? found > threshold.bound : found < threshold.bound;
}

/** One tool rule, judged against what the tool actually resolved. */
function judge(toolRule, tool, answer) {
  const at = { tool, rule: toolRule.id };
  if (!answer || answer.ok !== true) {
    return { ...at, present: 'unknown', reason: answer?.reason ?? 'nothing resolved a configuration for this tool' };
  }
  if (toolRule.requires === 'type-aware' && answer.typeAware !== true) {
    return {
      ...at,
      present: 'unknown',
      reason: 'needs type information — this config declares no parser project, so the rule cannot run',
    };
  }

  const entry = answer.rules?.[toolRule.id];
  if (entry === undefined) return { ...at, present: false, reason: 'not in the resolved configuration' };

  const severity = severityOf(entry);
  if (severity === null) return { ...at, present: 'unknown', reason: 'the resolved entry is in a shape we do not read' };
  if (severity === 0) return { ...at, present: false, severity, reason: 'configured off' };

  const found = normaliseThreshold(entry, toolRule.threshold?.numeric ?? '');
  const weaker = isWeaker(found, toolRule.threshold);
  return { ...at, present: true, severity, found, weaker };
}

/**
 * Per doctrine rule: does this project's tooling already decide it?
 *
 * Five verdicts, and the fourth is the one worth arguing for. `unknown` exists
 * because a resolve that could not run — a linter declared but not installed, a
 * config that extends something we cannot follow — is **not** evidence that a
 * rule is absent. Folding it into `missing` would make the command propose a
 * rule the project may already have, which is the single failure
 * `/dev-lint-rules` was built to prevent, and it is contract rule 2's silently
 * wrong guess. `doctrine-only` is the fifth, and it is a verdict rather than an
 * omission because a later ticket reads it to know which bullets the prompt
 * must keep.
 *
 * @param {{rules?: DoctrineRule[], resolved?: Record<string, object>, tools?: string[]}} input
 *   `tools` are the tools configured in this project; `resolved` is each one's
 *   answer, `{ok: true, rules, typeAware?}` or `{ok: false, reason}`.
 */
export function coverageOf({ rules = DOCTRINE_RULES, resolved = {}, tools = [] } = {}) {
  const configured = new Set(tools);

  return [...rules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((rule) => {
      const base = {
        id: rule.id,
        section: rule.section,
        statement: rule.statement,
        level: rule.level,
        why: rule.why,
        ...(rule.caveat ? { caveat: rule.caveat } : {}),
        ...(rule.needsProjectInput ? { needsProjectInput: true } : {}),
      };

      if (rule.level === 'doctrine-only') {
        return { ...base, verdict: 'doctrine-only', expressible: false, evidence: [], reason: rule.why };
      }

      // A tool the project does not have says nothing about this project. What
      // it would have said is reported as the reason, not as a verdict.
      const usable = DOCTRINE_TOOLS.filter((t) => configured.has(t) && rule.tools[t]);
      if (usable.length === 0) {
        const could = DOCTRINE_TOOLS.filter((t) => rule.tools[t]);
        const reason = could.length
          ? `no configured linter here can express this — ${could.join(', ')} can, and ` +
            DOCTRINE_TOOLS.filter((t) => configured.has(t))
              .map((t) => `${t}: ${rule.absent[t] ?? 'has no equivalent'}`)
              .join('; ')
          : 'no linter can express this';
        return { ...base, verdict: 'missing', expressible: false, evidence: [], reason };
      }

      const evidence = usable
        .flatMap((tool) => rule.tools[tool].map((tr) => judge(tr, tool, resolved[tool])))
        .sort((a, b) => a.tool.localeCompare(b.tool) || a.rule.localeCompare(b.rule));

      const verdict = aggregate(evidence, rule.satisfiedBy);
      return { ...base, verdict, expressible: true, evidence };
    });
}

/** Many tool rules, one verdict. */
function aggregate(evidence, satisfiedBy) {
  if (evidence.some((e) => e.present === 'unknown')) return 'unknown';
  const present = evidence.filter((e) => e.present === true);
  if (present.length === 0) return 'missing';

  if (satisfiedBy === 'any') {
    // A family where one member suffices has no middle: either something
    // decides it or nothing does.
    return present.some((e) => !e.weaker) ? 'covered' : 'partial';
  }
  if (present.length < evidence.length) return 'partial';
  return present.some((e) => e.weaker) ? 'partial' : 'covered';
}

/** The verdicts, counted. */
export function summarise(coverage = []) {
  const counts = { covered: 0, partial: 0, missing: 0, unknown: 0, doctrineOnly: 0 };
  for (const entry of coverage) {
    if (entry.verdict === 'doctrine-only') counts.doctrineOnly += 1;
    else counts[entry.verdict] += 1;
  }
  return counts;
}

/**
 * A JavaScript literal, for a flat ESLint config.
 *
 * A flat config is JavaScript, so a rule pasted into one has to be written as
 * JavaScript — `JSON.stringify` would produce double-quoted keys in a file
 * whose every other line is single-quoted, and the point of a paste-ready
 * snippet is that it can be pasted.
 */
function jsLiteral(value) {
  if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(jsLiteral).join(', ')}]`;
  if (value && typeof value === 'object') {
    const body = Object.entries(value)
      .map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : jsLiteral(k)}: ${jsLiteral(v)}`)
      .join(', ');
    return `{ ${body} }`;
  }
  return JSON.stringify(value);
}

/** The tools a dialect can carry a rule for. */
const DIALECT_TOOLS = {
  flat: ['eslint', 'typescriptEslint'],
  eslintrc: ['eslint', 'typescriptEslint'],
  biome: ['biome'],
};

/**
 * The paste-ready snippet for a doctrine rule, in the dialect the found config
 * actually uses — or `null` when nothing should be proposed.
 *
 * Nothing is proposed for a `doctrine-only` rule, for a rule no configured
 * linter can express, for one already `covered`, or for one whose verdict is
 * `unknown`: in the last case the honest output is the reason the answer is
 * unknown, and a snippet would be a config line offered on a guess.
 *
 * **A legacy `.eslintrc` is rendered as eslintrc and never as flat config.**
 * The rule ids and options are identical either side of the split — only the
 * wrapper differs — so a project on the old format gets a snippet it can paste,
 * and migrating is left as the separate decision it is.
 *
 * @param {{id: string, verdict?: string, evidence?: object[]}} entry
 * @param {{dialect: 'flat'|'eslintrc'|'biome'}} options
 * @returns {string|null}
 */
export function renderSuggestion(entry, { dialect } = {}) {
  const rule = DOCTRINE_RULES.find((r) => r.id === entry?.id);
  if (!rule || rule.level === 'doctrine-only') return null;
  if (entry.expressible === false) return null;
  if (entry.verdict === 'covered' || entry.verdict === 'unknown') return null;

  const already = new Set(
    (entry.evidence ?? []).filter((e) => e.present === true && !e.weaker).map((e) => e.rule),
  );
  const wanted = (DIALECT_TOOLS[dialect] ?? [])
    .flatMap((tool) => rule.tools[tool] ?? [])
    .filter((tr) => !already.has(tr.id));
  if (wanted.length === 0) return null;

  if (dialect === 'biome') {
    // Biome nests a rule under its group, so the snippet is the group object
    // rather than one line — pasted under `linter.rules`.
    const groups = {};
    for (const tr of wanted) {
      const [group, name] = tr.id.split('/');
      (groups[group] ??= {})[name] = tr.severity;
    }
    return Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, entries]) => `${JSON.stringify(group)}: ${JSON.stringify(entries, null, 2)},`)
      .join('\n');
  }

  return wanted
    .map((tr) => {
      const args = [tr.severity, ...tr.options];
      return dialect === 'eslintrc'
        ? `${JSON.stringify(tr.id)}: ${JSON.stringify(args)},`
        : `${jsLiteral(tr.id)}: ${jsLiteral(args)},`;
    })
    .join('\n');
}

/**
 * JSON with comments and trailing commas, made parseable — or refused.
 *
 * Both `biome.json` and `tsconfig.json` permit what JSON does not, and there is
 * no parser to reach for: the payload runs from plain source with no
 * `node_modules`. So this strips exactly two things and **refuses everything it
 * is not certain about**, returning the line rather than a best effort. A
 * stripper that is usually right corrupts a config silently, and the caller
 * then reports rules the project never configured.
 *
 * @returns {{ok: true, text: string} | {ok: false, line: number, reason: string}}
 */
export function stripJsonc(text = '') {
  let out = '';
  let line = 1;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      const start = line;
      out += ch;
      i += 1;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
          out += c + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '\n') {
          // A raw newline inside a string is not something JSON allows, so we
          // are no longer reading what we thought we were reading.
          return { ok: false, line: start, reason: `unterminated string starting on line ${start}` };
        }
        out += c;
        i += 1;
        if (c === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return { ok: false, line: start, reason: `unterminated string starting on line ${start}` };
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = line;
      i += 2;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\n') line += 1;
        if (text[i] === '*' && text[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return { ok: false, line: start, reason: `unterminated comment starting on line ${start}` };
      out += ' ';
      continue;
    }

    if (ch === '\n') line += 1;
    out += ch;
    i += 1;
  }

  // Trailing commas, now that no comma inside a string can be mistaken for one.
  return { ok: true, text: out.replace(/,(\s*[}\]])/g, '$1') };
}

/** The biome config filenames, in the order biome itself looks for them. */
const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];

/** Biome writes a rule as a severity, or as an object carrying one. */
function biomeSeverity(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.level === 'string') return value.level;
  return null;
}

/**
 * What biome's configuration switches on.
 *
 * **Biome is the one tool whose coverage is read rather than run, and that is a
 * decision rather than an oversight.** It exposes no resolved-config surface,
 * so the only run-based alternative is to compare a forced-on run against a
 * default one and infer enablement from the difference — which proves nothing
 * whenever a rule has no violations, i.e. exactly the healthy project where the
 * answer matters most. Its config is JSON, so reading it needs no dependency
 * and no guess. The report says which kind of answer it gave, per tool, because
 * a reader must never have to work that out.
 *
 * @param {{files?: string[], read?: (path: string) => string|null}} input
 * @returns {{ok: true, source: 'config', rules: object, typeAware: boolean, note?: string}
 *          | {ok: false, reason: string}}
 */
export function parseBiomeConfig({ files = [], read = () => null } = {}) {
  const present = new Set(files);
  const entry = BIOME_CONFIGS.find((name) => present.has(name));
  if (!entry) return { ok: false, reason: 'no biome config in this repo' };

  // Child last, so a later spread wins — biome resolves `extends` the same way.
  const chain = [];
  const seen = new Set();
  const walk = (path, depth) => {
    if (depth > 5) return { ok: false, reason: `biome extends more than five levels deep, starting at ${entry}` };
    if (seen.has(path)) return { ok: true };
    seen.add(path);

    const text = read(path);
    if (text === null) return { ok: false, reason: `biome extends "${path}", which is not in this repo` };
    const stripped = stripJsonc(text);
    if (!stripped.ok) return { ok: false, reason: `${path} is not readable as JSON: ${stripped.reason}` };

    let config;
    try {
      config = JSON.parse(stripped.text);
    } catch (err) {
      return { ok: false, reason: `${path} is not readable as JSON: ${err.message}` };
    }

    for (const spec of config.extends ?? []) {
      if (typeof spec !== 'string' || !spec.startsWith('.')) {
        return {
          ok: false,
          reason:
            `biome extends "${spec}", which needs node module resolution — coverage cannot be ` +
            'decided from the files alone',
        };
      }
      // Relative to the repo root is close enough while every config we follow
      // sits at the root; a nested one names its parent from there too.
      const resolved = spec.replace(/^\.\//, '');
      const out = walk(resolved, depth + 1);
      if (!out.ok) return out;
    }

    chain.push(config);
    return { ok: true };
  };

  const walked = walk(entry, 0);
  if (!walked.ok) return walked;

  const merged = { linter: { rules: {} } };
  for (const config of chain) {
    const linter = config.linter ?? {};
    if (linter.enabled !== undefined) merged.linter.enabled = linter.enabled;
    for (const [group, value] of Object.entries(linter.rules ?? {})) {
      if (group === 'recommended') {
        merged.linter.rules.recommended = value;
        continue;
      }
      merged.linter.rules[group] = { ...(merged.linter.rules[group] ?? {}), ...value };
    }
  }

  if (merged.linter.enabled === false) {
    return { ok: true, source: 'config', rules: {}, typeAware: false, note: 'the biome linter is disabled' };
  }

  const rules = {};
  // The recommended preset switches on a fixed set, and which of our rules are
  // in it is data on each entry rather than a list restated here.
  if (merged.linter.rules.recommended === true) {
    for (const rule of DOCTRINE_RULES) {
      for (const tr of rule.tools.biome ?? []) {
        if (tr.recommended === true) rules[tr.id] = 'error';
      }
    }
  }
  for (const [group, entries] of Object.entries(merged.linter.rules)) {
    if (group === 'recommended' || !entries || typeof entries !== 'object') continue;
    for (const [name, value] of Object.entries(entries)) {
      if (name === 'recommended') continue;
      const severity = biomeSeverity(value);
      if (severity !== null) rules[`${group}/${name}`] = severity;
    }
  }

  return { ok: true, source: 'config', rules, typeAware: false };
}
