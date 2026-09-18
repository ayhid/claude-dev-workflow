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
 * @property {'id'|'entry'} placeholder  what `<RULE>` takes — see below
 * @property {{config: string, count: string}[]} variants  a recipe the found config overrides
 * @property {string|null} resolve  reports the tool's **resolved** configuration; `<FILE>`
 * @property {'run'|'config'|'none'} resolveKind  how coverage is answered for this tool
 * @property {string} [resolveWhy]  why it is not `run` — required whenever it is not
 * @property {string|null} lintFile  lints one file, for the edit hook; `<FILE>`

 *
 * `placeholder` is data rather than a convention because the two kinds cannot
 * be told apart by looking. For almost every linter a rule is a name and its
 * severity is a flag, so `<RULE>` is an id. commitlint's rules are tuples whose
 * **third** element is the value — `type-enum` without its enum matches nothing
 * — so substituting a bare id there produces a number that looks like an answer.
 * A wrong count is worse than no count, and the skill says so in as many words.
 */
export const LINTERS = [
  {
    name: 'eslint',
    language: 'JavaScript, TypeScript',
    configs: [
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
      'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    ],
    embedded: [{ file: 'package.json', marker: '"eslintConfig"' }],
    // Flat config, v9 and after.
    count: `npx --no-install eslint . --no-config-lookup --rule '{"<RULE>": "error"}'`,
    // `--no-eslintrc` was removed in v9 and is the only spelling before it, so
    // the config file that was found is what decides. Printing the other one is
    // a count the user cannot reproduce.
    placeholder: 'id',
    resolve: 'npx --no-install eslint --print-config <FILE>',
    resolveKind: 'run',
    lintFile: 'npx --no-install eslint <FILE>',
    variants: [{ config: '.eslintrc', count: `npx --no-install eslint . --no-eslintrc --rule '{"<RULE>": "error"}'` }],
  },
  {
    name: 'biome',
    language: 'JavaScript, TypeScript',
    configs: ['biome.json', 'biome.jsonc'],
    embedded: [],
    count: 'npx --no-install biome lint --only=<RULE> .',
    placeholder: 'id',
    resolve: null,
    resolveKind: 'config',
    resolveWhy:
      'biome has no --print-config; its configuration is JSON and is read directly instead',
    lintFile: 'npx --no-install biome lint <FILE>',
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
    count: `printf '{"rules":{"<RULE>": true}}' > /tmp/one-rule.json && npx --no-install stylelint "**/*.css" --config /tmp/one-rule.json`,
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto CSS yet; stylelint --print-config is where to start when one does',
    lintFile: null,
    variants: [],
  },
  {
    name: 'ruff',
    language: 'Python',
    configs: ['ruff.toml', '.ruff.toml'],
    embedded: [{ file: 'pyproject.toml', marker: '[tool.ruff' }],
    count: 'ruff check --select <RULE> --statistics .',
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Python yet; ruff check --show-settings is where to start when one does',
    lintFile: null,
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
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Python yet, and flake8 reports no resolved configuration at all',
    lintFile: null,
    variants: [],
  },
  {
    name: 'pylint',
    language: 'Python',
    configs: ['.pylintrc', 'pylintrc'],
    embedded: [{ file: 'pyproject.toml', marker: '[tool.pylint' }],
    count: 'pylint --disable=all --enable=<RULE> .',
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Python yet; pylint --generate-toml-config is where to start when one does',
    lintFile: null,
    variants: [],
  },
  {
    name: 'clippy',
    language: 'Rust',
    configs: ['clippy.toml', '.clippy.toml'],
    embedded: [{ file: 'Cargo.toml', marker: '[lints.clippy' }],
    count: 'cargo clippy --all-targets -- -A clippy::all -W clippy::<RULE>',
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Rust yet, and clippy reports no resolved lint set',
    lintFile: null,
    variants: [],
  },
  {
    name: 'rubocop',
    language: 'Ruby',
    configs: ['.rubocop.yml', '.rubocop.yaml'],
    embedded: [],
    count: 'rubocop --only <RULE> --format offenses',
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Ruby yet; rubocop --show-cops is where to start when one does',
    lintFile: null,
    variants: [],
  },
  {
    name: 'golangci-lint',
    language: 'Go',
    configs: ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'],
    embedded: [],
    count: 'golangci-lint run --disable-all -E <RULE> ./...',
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Go yet; golangci-lint config dump is where to start when one does',
    lintFile: null,
    variants: [],
  },
  {
    name: 'shellcheck',
    language: 'Shell',
    configs: ['.shellcheckrc'],
    embedded: [],
    count: `shellcheck --include=<RULE> $(git ls-files '*.sh' '*.bash')`,
    placeholder: 'id',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'no doctrine rule maps onto Shell yet, and shellcheck reports no resolved configuration',
    lintFile: null,
    variants: [],
  },
  {
    name: 'commitlint',
    language: 'commit messages',
    configs: [
      'commitlint.config.js', 'commitlint.config.mjs', 'commitlint.config.cjs',
      'commitlint.config.ts', 'commitlint.config.mts', 'commitlint.config.cts',
      '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yml', '.commitlintrc.yaml',
      '.commitlintrc.js', '.commitlintrc.cjs', '.commitlintrc.mjs',
      '.commitlintrc.ts', '.commitlintrc.cts', '.commitlintrc.mts',
    ],
    embedded: [{ file: 'package.json', marker: '"commitlint"' }],
    // The violations are in the history, not the tree, so the count is over
    // commits. A range is what makes it a number rather than an opinion.
    //
    // `<RULE>` is the whole entry here, tuple included: `type-enum` counts
    // nothing without the enum in its third element.
    count: `printf 'export default { rules: { <RULE> } }' > /tmp/one-rule.mjs && npx --no-install commitlint --from HEAD~50 --config /tmp/one-rule.mjs`,
    placeholder: 'entry',
    resolve: null,
    resolveKind: 'none',
    resolveWhy:
      'the doctrine is about code, not commit messages, so nothing here maps onto commitlint',
    lintFile: null,
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
/**
 * Where a project might actually invoke a linter.
 *
 * Detecting a config file says a linter is **set up**. It says nothing about
 * whether anything runs it, and a rule added to a linter nobody runs will never
 * fail anything — which is a thing a project should hear before it spends an
 * afternoon choosing rules.
 *
 * A table rather than a search, for the reason `LINTERS` is one: the places a
 * project can invoke a tool from are finite and known, and asking a model to
 * remember them is how a `lefthook.yml` goes unread.
 *
 * `file` is read directly; `dir` enumerates the tracked paths beneath it, so
 * `.github/workflows/*.yml` needs no directory listing.
 */
export const INVOCATION_SITES = [
  { id: 'npm-scripts', file: 'package.json', kind: 'scripts' },
  { id: 'lint-staged', file: 'package.json', kind: 'json', at: 'lint-staged' },
  { id: 'lint-staged', file: '.lintstagedrc.json', kind: 'text' },
  { id: 'husky', dir: '.husky', kind: 'text' },
  { id: 'lefthook', file: 'lefthook.yml', kind: 'text' },
  { id: 'lefthook', file: 'lefthook.yaml', kind: 'text' },
  { id: 'pre-commit', file: '.pre-commit-config.yaml', kind: 'text' },
  { id: 'github-actions', dir: '.github/workflows', kind: 'text' },
  { id: 'claude-hooks', file: '.claude/settings.json', kind: 'text' },
];

/** Read a path, answering null for anything unreadable. Never throws. */
function bodyOf(read, path) {
  try {
    const text = read(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** Does `text` name `word` as a word, rather than inside a longer one? */
function names(text, word) {
  // `eslint-config-acme` in a dependency list is not something running eslint,
  // and a bare substring match counts it as one.
  return new RegExp(`(?<![\\w@/-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
}

/**
 * What names each configured linter, and how.
 *
 * Two passes. The first is direct: the tool's own name appears at a site. The
 * second is transitive through npm scripts — a CI step reading `run: pnpm lint`
 * invokes the linter just as surely as one reading `run: eslint .`, and a
 * direct-only match reports most projects as unenforced.
 *
 * **What this proves is that the name appears, not that the command runs**: a
 * commented-out CI step matches. That is why the caller labels the result
 * `named in` rather than `runs in` — the weaker claim is the true one, and
 * naming it honestly is worth more than a stronger claim that is sometimes
 * wrong.
 *
 * @param {{files?: string[], read?: (p: string) => string|null, linters?: object[]}} input
 * @returns {Record<string, {site: string, where: string, via: string}[]>}
 */
export function detectInvocations({ files = [], read = () => null, linters = [] } = {}) {
  const present = new Set(files);
  const pkg = (() => {
    const text = bodyOf(read, 'package.json');
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const scripts = pkg?.scripts ?? {};

  /** Every way a site could spell "run this npm script". */
  const invocationsOf = (script) => [`npm run ${script}`, `pnpm ${script}`, `pnpm run ${script}`,
    `yarn ${script}`, `yarn run ${script}`, `bun run ${script}`, `make ${script}`];

  const found = {};
  for (const linter of linters) {
    const hits = [];
    const viaScripts = Object.entries(scripts)
      .filter(([, body]) => typeof body === 'string' && names(body, linter.name))
      .map(([name]) => name)
      .sort();

    for (const script of viaScripts) {
      hits.push({ site: 'npm-scripts', where: `package.json#scripts.${script}`, via: 'direct' });
    }

    for (const site of INVOCATION_SITES) {
      const paths = site.dir
        ? files.filter((f) => f.startsWith(`${site.dir}/`)).sort()
        : present.has(site.file)
          ? [site.file]
          : [];

      for (const path of paths) {
        // npm scripts are reported above, per script, rather than as one hit
        // on package.json — which script runs the linter is the useful part.
        if (site.kind === 'scripts') continue;

        const text = bodyOf(read, path);
        if (text === null) continue;

        const body = site.at ? JSON.stringify(jsonAt(text, site.at) ?? '') : text;
        if (names(body, linter.name)) {
          hits.push({ site: site.id, where: path, via: 'direct' });
          continue;
        }
        const via = viaScripts.flatMap(invocationsOf).find((spelling) => body.includes(spelling));
        if (via) hits.push({ site: site.id, where: path, via });
      }
    }

    // One hit per place. A site that both names the tool and runs a script
    // that names it is still one place the linter runs.
    const seen = new Set();
    found[linter.name] = hits
      .filter((hit) => !seen.has(hit.where) && seen.add(hit.where))
      .sort((a, b) => a.where.localeCompare(b.where));
  }
  return found;
}

/** One key out of a JSON file, or undefined when it is not JSON. */
function jsonAt(text, key) {
  try {
    return JSON.parse(text)?.[key];
  } catch {
    return undefined;
  }
}

/**
 * The invocation that reports a linter's resolved configuration, for a file.
 *
 * Detecting a config file says a linter is **set up**; only the resolved
 * configuration says which rules are **on**, and the difference is whether a
 * rule can be proposed to a project that already has it. `<FILE>` is a file the
 * tool decides a configuration for — ESLint resolves per path, so a repository
 * with per-directory overrides has no single answer and the caller picks one
 * deterministically.
 *
 * Returns `null` for a linter whose coverage is not answered by running it;
 * `resolveWhy` on the entry says why, and the report prints it.
 *
 * @param {object} linter  an entry as `detectLinters` returns it
 * @param {string} file    the path to resolve a configuration for
 */
export function resolveRecipe(linter, file) {
  const template = resolveTemplate(linter);
  return template === null ? null : template.replaceAll('<FILE>', file);
}

/** The recipe the found config takes, before anything is substituted into it. */
function resolveTemplate(linter) {
  if (linter.resolveKind !== 'run' || !linter.resolve) return null;
  const variant = (linter.variants ?? []).find((v) =>
    (linter.configs ?? []).some((c) => c.startsWith(v.config)),
  );
  return variant?.resolve ?? linter.resolve;
}

/**
 * The same recipe as an argument array, which is what actually gets run.
 *
 * `resolveRecipe` is for the report — a line a reader can paste. This is for
 * the spawn, and it is a separate function because the two must not be the
 * same string: a path carrying a space survives an argv element and does not
 * survive being split back out of a sentence. Nothing here is ever handed to a
 * shell (lib/sh.mjs).
 *
 * @returns {string[]|null}
 */
export function resolveArgv(linter, file) {
  const template = resolveTemplate(linter);
  if (template === null) return null;
  return template.split(/\s+/).map((token) => (token === '<FILE>' ? file : token));
}

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
export const LANGUAGE_BY_EXTENSION = {
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
