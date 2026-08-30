/**
 * What a project already enforces, and what it merely states.
 *
 * `/dev-lint-rules` rests on one distinction: a stated convention is either
 * **deterministic**, in which case a linter can decide it and a document
 * restating it is a weaker second copy of a rule that already has an enforcer —
 * or it is not, in which case it is unfalsifiable prose and no rule should be
 * proposed for it at all.
 *
 * Both halves have to be mechanical before that skill can be trusted. Which
 * linter a project has is a file-existence question with a fixed answer, and
 * asking a model to remember the table is how a `ruff` rule gets proposed for a
 * project that has never had Python in it. So the table lives here, the skill
 * reads prose, and the two do not overlap.
 *
 * Pure, with its reader injected (provider.mjs rule 1) so it is testable
 * without a repository, and deterministic (rule 4) so the same project reports
 * the same bytes twice.
 */

/**
 * The linters we can name, and — the load-bearing half — the invocation that
 * runs **one** rule against the existing tree.
 *
 * A rule proposed without that count is a config line masquerading as a
 * decision: switching one on that lights up four hundred existing violations is
 * the user's call, and the number is what makes it one. So a linter with no way
 * to count a single rule does not belong in this table, and the test asserts
 * every entry has one.
 *
 * @property {string}   name      the tool, as it is invoked
 * @property {string}   language  what it lints, for the report
 * @property {string[]} configs   config files that mean it is set up
 * @property {{file: string, marker: string}[]} embedded  configs living inside a shared file
 * @property {string}   count     runs `<RULE>` alone; what it prints is the count
 * @property {{config: string, count: string}[]} variants  a recipe the found config overrides
 */
export const LINTERS = [
  {
    name: 'eslint',
    language: 'JavaScript, TypeScript',
    configs: [
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    ],
    embedded: [{ file: 'package.json', marker: '"eslintConfig"' }],
    // Flat config, v9 and after.
    count: `npx eslint . --no-config-lookup --rule '{"<RULE>": "error"}'`,
    // `--no-eslintrc` was removed in v9 and is the only spelling before it, so
    // the config file that was found is what decides. Printing the other one is
    // a count the user cannot reproduce.
    variants: [{ config: '.eslintrc', count: `npx eslint . --no-eslintrc --rule '{"<RULE>": "error"}'` }],
  },
  {
    name: 'biome',
    language: 'JavaScript, TypeScript',
    configs: ['biome.json', 'biome.jsonc'],
    embedded: [],
    count: 'npx biome lint --only=<RULE> .',
    variants: [],
  },
  {
    name: 'stylelint',
    language: 'CSS',
    configs: [
      '.stylelintrc', '.stylelintrc.json', '.stylelintrc.js', '.stylelintrc.cjs',
      '.stylelintrc.yml', '.stylelintrc.yaml', 'stylelint.config.js', 'stylelint.config.mjs',
      'stylelint.config.cjs',
    ],
    embedded: [{ file: 'package.json', marker: '"stylelint"' }],
    // `--config` takes a path, not an inline rule, so the one rule goes in a
    // scratch file rather than being approximated by a flag that does not exist.
    count: `printf '{"rules":{"<RULE>": true}}' > /tmp/one-rule.json && npx stylelint "**/*.css" --config /tmp/one-rule.json`,
    variants: [],
  },
  {
    name: 'ruff',
    language: 'Python',
    configs: ['ruff.toml', '.ruff.toml'],
    embedded: [{ file: 'pyproject.toml', marker: '[tool.ruff' }],
    count: 'ruff check --select <RULE> --statistics .',
    variants: [],
  },
  {
    name: 'flake8',
    language: 'Python',
    configs: ['.flake8'],
    embedded: [
      { file: 'setup.cfg', marker: '[flake8]' },
      { file: 'tox.ini', marker: '[flake8]' },
    ],
    count: 'flake8 --select=<RULE> .',
    variants: [],
  },
  {
    name: 'pylint',
    language: 'Python',
    configs: ['.pylintrc', 'pylintrc'],
    embedded: [{ file: 'pyproject.toml', marker: '[tool.pylint' }],
    count: 'pylint --disable=all --enable=<RULE> .',
    variants: [],
  },
  {
    name: 'clippy',
    language: 'Rust',
    configs: ['clippy.toml', '.clippy.toml'],
    embedded: [{ file: 'Cargo.toml', marker: '[lints.clippy' }],
    count: 'cargo clippy --all-targets -- -A clippy::all -W clippy::<RULE>',
    variants: [],
  },
  {
    name: 'rubocop',
    language: 'Ruby',
    configs: ['.rubocop.yml', '.rubocop.yaml'],
    embedded: [],
    count: 'rubocop --only <RULE> --format offenses',
    variants: [],
  },
  {
    name: 'golangci-lint',
    language: 'Go',
    configs: ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'],
    embedded: [],
    count: 'golangci-lint run --disable-all -E <RULE> ./...',
    variants: [],
  },
  {
    name: 'shellcheck',
    language: 'Shell',
    configs: ['.shellcheckrc'],
    embedded: [],
    count: `shellcheck --include=<RULE> $(git ls-files '*.sh' '*.bash')`,
    variants: [],
  },
  {
    name: 'commitlint',
    language: 'commit messages',
    configs: [
      'commitlint.config.js', 'commitlint.config.mjs', 'commitlint.config.cjs', 'commitlint.config.ts',
      '.commitlintrc', '.commitlintrc.json', '.commitlintrc.js', '.commitlintrc.yml', '.commitlintrc.yaml',
    ],
    embedded: [{ file: 'package.json', marker: '"commitlint"' }],
    // The violations are in the history, not the tree, so the count is over
    // commits. A range is what makes it a number rather than an opinion.
    count: `printf 'export default { rules: { "<RULE>": [2, "always"] } }' > /tmp/one-rule.mjs && npx commitlint --from HEAD~50 --config /tmp/one-rule.mjs`,
    variants: [],
  },
];

/**
 * The linter a language's ecosystem has settled on, for the report that has
 * none to name.
 *
 * Naming one is not the same as configuring one: refusal 3 is that a project
 * with no lint setup is *told* so, and a config file for a tool nobody
 * installed is a rule that will never run and will never be noticed not
 * running.
 */
export const STANDARD_LINTERS = {
  'JavaScript': 'eslint',
  'TypeScript': 'eslint',
  'Python': 'ruff',
  'Rust': 'clippy',
  'Ruby': 'rubocop',
  'Go': 'golangci-lint',
  'Shell': 'shellcheck',
};

/**
 * The documents a project states its conventions in.
 *
 * By name, never by guess. Everything under `docs/` is deliberately absent: a
 * documentation set is the ledger's territory, and reading a generated
 * `architecture.md` back in as a convention would compound whatever put it
 * there.
 */
export const CONVENTION_SOURCES = [
  { path: 'CLAUDE.md', why: 'rules stated to the agent — every imperative is a candidate' },
  { path: 'AGENTS.md', why: 'rules stated to the agent — every imperative is a candidate' },
  { path: 'CONTRIBUTING.md', why: 'rules stated to contributors, usually never enforced' },
  { path: '.github/CONTRIBUTING.md', why: 'rules stated to contributors, usually never enforced' },
  { path: '.cursorrules', why: 'rules stated to another agent, and just as unenforced' },
  { path: '.github/copilot-instructions.md', why: 'rules stated to another agent, and just as unenforced' },
  { path: 'GEMINI.md', why: 'rules stated to another agent, and just as unenforced' },
  { path: 'STYLEGUIDE.md', why: 'a style guide is conventions by definition' },
];

const sortBy = (list, key) => [...list].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

/**
 * Which linters this project has configured.
 *
 * A tracked file that cannot be read abstains rather than counting as absent —
 * a sparse checkout is not evidence that ruff is unconfigured.
 *
 * @param {{files: string[], read: (path: string) => (string|null)}} input
 * @returns {object[]} the entries from LINTERS that are configured, with the paths that say so
 */
export function detectLinters({ files = [], read = () => null } = {}) {
  const present = new Set(files);
  const found = [];

  for (const linter of LINTERS) {
    const configs = linter.configs.filter((c) => present.has(c));

    for (const { file, marker } of linter.embedded) {
      if (!present.has(file) || configs.includes(file)) continue;
      let body = null;
      try {
        body = read(file);
      } catch {
        // Unreadable is not evidence either way. Nothing is added.
      }
      if (typeof body === 'string' && body.includes(marker)) configs.push(file);
    }

    if (configs.length) found.push({ ...linter, configs: configs.sort() });
  }

  return found;
}

/**
 * The invocation that counts one rule's violations, for a linter as it is
 * actually configured here.
 *
 * @param {object} linter  an entry from `detectLinters`
 * @param {string} rule    the rule id, in the linter's own vocabulary
 */
export function countRecipe(linter, rule) {
  const variant = (linter.variants ?? []).find((v) =>
    (linter.configs ?? []).some((c) => c.startsWith(v.config)),
  );
  return (variant?.count ?? linter.count).replaceAll('<RULE>', rule);
}

/**
 * The convention documents this project actually has.
 *
 * @param {string[]} files  tracked paths
 */
export function statedSources(files = []) {
  const present = new Set(files);
  return sortBy(CONVENTION_SOURCES.filter((s) => present.has(s.path)), 'path');
}

const bullet = (s) => `  - ${s}`;

/**
 * The report. A pure function of its input, so the same project prints the same
 * bytes twice and a diff of two runs is a change in the project.
 *
 * @param {{linters: object[], checks: string[], sources: object[], claims: object[], languages: string[]}} input
 */
export function renderRules({ linters = [], checks = [], sources = [], claims = [], languages = [] } = {}) {
  const L = [];

  L.push('already enforced');
  if (linters.length) {
    for (const l of linters) L.push(bullet(`${l.name.padEnd(14)} ${l.language.padEnd(24)} ${l.configs.join(', ')}`));
  } else {
    L.push(bullet('no linter is configured in this project'));
  }

  // Refusal 3, and the reason it is a refusal: for these there is nothing to
  // propose a rule *into*, so the answer is the name of a tool and never a
  // config file for one nobody installed.
  //
  // Computed per language rather than only when the list is empty, because the
  // partial case is the one that misleads: a project that lints its commit
  // messages and nothing else reports one linter, and a reader takes the
  // language it is actually written in to be covered.
  const covered = new Set(linters.flatMap((l) => l.language.split(',').map((s) => s.trim())));
  const uncovered = languages.filter((lang) => !covered.has(lang) && STANDARD_LINTERS[lang]);
  if (uncovered.length) {
    L.push('', 'not linted at all');
    for (const lang of uncovered) {
      L.push(bullet(`${lang.padEnd(14)} the standard one is ${STANDARD_LINTERS[lang]} — installing it is a decision, not a proposal`));
    }
  }

  L.push('', 'checks that run');
  if (checks.length) for (const c of checks) L.push(bullet(c));
  else L.push(bullet('none configured in .dev-workflow.json'));

  L.push('', 'conventions are stated in');
  if (sources.length) for (const s of sources) L.push(bullet(`${s.path.padEnd(38)} ${s.why}`));
  else L.push(bullet('nothing states a convention in writing — there is nothing to turn into rules'));

  // Only `intent`. An `observable` claim is a description of the code, not a
  // rule somebody wants obeyed, and proposing a linter rule for one would be
  // enforcing the present against itself.
  const intent = sortBy(claims.filter((c) => c?.kind === 'intent'), 'text');
  L.push('', `intent claims in the ledger (${intent.length})`);
  if (intent.length) {
    for (const c of intent) L.push(bullet(`${c.text}${c.source ? `  (${c.source})` : ''}`));
  } else {
    L.push(bullet('none — no documentation ledger, or nothing in it is a stated position'));
  }

  return `${L.join('\n')}\n`;
}

/**
 * Extension to language, for the languages `STANDARD_LINTERS` can name.
 *
 * Deliberately not the full list `lib/ingest.mjs` classifies as source: this
 * one exists only to answer "what would you lint this with", so an extension
 * with no standard linter behind it would name nothing and is left out.
 */
const LANGUAGE_BY_EXTENSION = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.rs': 'Rust', '.rb': 'Ruby', '.go': 'Go',
  '.sh': 'Shell', '.bash': 'Shell',
};

/**
 * Which languages are in this tree, sorted.
 *
 * @param {string[]} files  tracked paths
 */
export function languagesOf(files = []) {
  const seen = new Set();
  for (const path of files) {
    const dot = path.lastIndexOf('.');
    const lang = dot === -1 ? null : LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()];
    if (lang) seen.add(lang);
  }
  return [...seen].sort();
}
