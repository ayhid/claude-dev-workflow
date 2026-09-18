/**
 * What a project already enforces, and what it merely states.
 *
 * The rule under test is the one `/dev-lint-rules` is built on: a stated
 * convention is either **deterministic**, in which case a linter can decide it,
 * or it is not, in which case no rule should be proposed for it at all. Both
 * halves have to be mechanical before the skill can be trusted — a skill that
 * asks a model to remember which config files mean which linter proposes a
 * `ruff` rule for a project that has never had Python in it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countRecipe,
  detectInvocations,
  detectLinters,
  INVOCATION_SITES,
  LANGUAGE_BY_EXTENSION,
  languagesOf,
  LINTERS,
  renderRules,
  resolveRecipe,
  STANDARD_LINTERS,
  statedSources,
} from '../lib/rules.mjs';

/** A reader over an in-memory tree, in the shape the detector takes. */
const reader = (tree) => (path) => (path in tree ? tree[path] : null);

test('a linter is detected from its own config file, and only from it', () => {
  const files = ['package.json', 'eslint.config.js', 'src/index.js'];
  const found = detectLinters({ files, read: reader({}) });

  const eslint = found.find((l) => l.name === 'eslint');
  assert.ok(eslint, 'eslint.config.js means eslint');
  assert.deepEqual(eslint.configs, ['eslint.config.js']);

  // The failure this guards: a JavaScript project is not a Python one, and a
  // proposed `ruff` rule for it is a rule nobody can run.
  assert.equal(
    found.find((l) => l.name === 'ruff'),
    undefined,
    'nothing about a JS project says ruff',
  );
});

test('an embedded config counts, and an unrelated file of the same name does not', () => {
  const withRuff = { 'pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n' };
  const without = { 'pyproject.toml': '[project]\nname = "x"\n' };

  const yes = detectLinters({ files: ['pyproject.toml'], read: reader(withRuff) });
  assert.deepEqual(
    yes.find((l) => l.name === 'ruff')?.configs,
    ['pyproject.toml'],
    'ruff configured inside pyproject.toml is still configured',
  );

  const no = detectLinters({ files: ['pyproject.toml'], read: reader(without) });
  assert.equal(
    no.find((l) => l.name === 'ruff'),
    undefined,
    'a pyproject.toml is not evidence of ruff by itself',
  );
});

test('an unreadable config is not evidence either way, and never throws', () => {
  // A tracked file that is not on disk — a sparse checkout, a broken link.
  const found = detectLinters({ files: ['pyproject.toml'], read: () => null });
  assert.equal(found.find((l) => l.name === 'ruff'), undefined);
});

test('every linter carries a way to count what a rule would flag', () => {
  // AC3: a proposed rule is presented with the violations it would flag, and a
  // count nobody can produce makes that a promise rather than a fact. The
  // table is the single place that promise is kept.
  for (const linter of LINTERS) {
    assert.match(
      linter.count,
      /<RULE>/,
      `${linter.name} must say how to count one rule's violations`,
    );
    assert.ok(linter.language, `${linter.name} must say what it lints`);
    assert.ok(linter.configs.length || linter.embedded.length, `${linter.name} must be detectable`);
  }
});

test('the count recipe is the one the detected config actually takes', () => {
  // ESLint took `--no-eslintrc` until v9 and `--no-config-lookup` after, and
  // the config file that was found is what says which. Printing the wrong one
  // is a count the user cannot reproduce.
  const flat = detectLinters({ files: ['eslint.config.mjs'], read: reader({}) })[0];
  assert.match(countRecipe(flat, 'no-console'), /--no-config-lookup/);
  assert.doesNotMatch(countRecipe(flat, 'no-console'), /--no-eslintrc/);

  const legacy = detectLinters({ files: ['.eslintrc.json'], read: reader({}) })[0];
  assert.match(countRecipe(legacy, 'no-console'), /--no-eslintrc/);

  // The placeholder is substituted, not printed.
  assert.match(countRecipe(flat, 'no-console'), /no-console/);
  assert.doesNotMatch(countRecipe(flat, 'no-console'), /<RULE>/);
});

test('the documents that state conventions are found by name, not guessed at', () => {
  const files = ['CLAUDE.md', 'CONTRIBUTING.md', 'docs/architecture.md', 'src/index.js'];
  const sources = statedSources(files);

  assert.deepEqual(
    sources.map((s) => s.path),
    ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'].filter((p) => files.includes(p)),
    'sorted, and only the ones that are there',
  );
  assert.ok(sources.every((s) => s.why), 'each says what it is being read for');
});

test('a project with no linter is told so, and is not given one', () => {
  // Refusal 3: it does not invent a linter. The report names the standard one
  // for the language rather than emitting config for a tool nobody installed.
  const out = renderRules({
    linters: [],
    checks: [],
    sources: statedSources(['CLAUDE.md']),
    claims: [],
  });

  assert.match(out, /no linter/i);
  assert.doesNotMatch(out, /--rule|--select/, 'no recipe for a linter that is not there');
});

test('only intent claims are offered, and the report is a pure function of its input', () => {
  const claims = [
    { text: 'sessions are in memory', kind: 'intent', source: 'ayoub', target: 'architecture' },
    { text: 'the entry point is src/server.ts', kind: 'observable', anchor: 'src/server.ts:12' },
  ];
  const input = {
    linters: detectLinters({ files: ['eslint.config.js'], read: reader({}) }),
    checks: ['npm test'],
    sources: statedSources(['CLAUDE.md']),
    claims,
  };

  const once = renderRules(input);
  assert.match(once, /sessions are in memory/);
  assert.doesNotMatch(once, /src\/server\.ts/, 'an observable claim is not a stated convention');

  // Contract rule 4: the same inputs print the same bytes.
  assert.equal(once, renderRules(input));
});

test('the languages present are read off the tree, so the standard linter can be named', () => {
  // Only used for the report that has no linter to name, and only ever to name
  // a tool — never to configure one.
  assert.deepEqual(languagesOf(['src/a.py', 'src/b.py', 'README.md']), ['Python']);
  assert.deepEqual(languagesOf(['a.ts', 'b.js', 'c.rs']), ['JavaScript', 'Rust', 'TypeScript']);
  assert.deepEqual(languagesOf(['README.md', 'LICENSE']), [], 'prose is not a language to lint');

  // Every language named must have a linter to name, or the report says
  // nothing useful.
  for (const lang of languagesOf(['a.py', 'a.js', 'a.ts', 'a.rs', 'a.rb', 'a.go', 'a.sh'])) {
    assert.ok(STANDARD_LINTERS[lang], `${lang} must have a standard linter`);
  }
});

test('a language with no linter is named even when some other linter is configured', () => {
  // The gap a bare "already enforced" list leaves. This repo lints its commit
  // messages and nothing else, and a report that lists commitlint and stops
  // reads as though JavaScript were covered.
  const out = renderRules({
    linters: detectLinters({ files: ['commitlint.config.mjs'], read: reader({}) }),
    checks: ['npm test'],
    sources: [],
    claims: [],
    languages: ['JavaScript'],
  });

  assert.match(out, /commitlint/, 'what is enforced is still reported');
  assert.match(out, /JavaScript/);
  assert.match(out, /eslint/, 'and the standard linter for it is named');
  assert.doesNotMatch(out, /--rule/, 'named, not configured — refusal 3');
});

test('a linter is detected under every config name it actually supports', () => {
  // The gap this closes is not cosmetic: an undetected config reads as "not
  // enforced", and the skill then proposes a rule the project already has —
  // the one thing AC2 exists to prevent.
  const detects = (file) => detectLinters({ files: [file], read: reader({}) })[0]?.name;

  for (const file of [
    '.commitlintrc.mjs', '.commitlintrc.cts', '.commitlintrc.mts',
    'commitlint.config.cts', 'commitlint.config.mts',
  ]) {
    assert.equal(detects(file), 'commitlint', `${file} configures commitlint`);
  }

  for (const file of ['eslint.config.mts', 'eslint.config.cts', '.eslintrc.cjs']) {
    assert.equal(detects(file), 'eslint', `${file} configures eslint`);
  }
});

test('a recipe says whether <RULE> takes a rule id or a whole rule entry', () => {
  // commitlint rules are tuples, and the value is the third element:
  // `type-enum` without its enum counts nothing. Substituting a bare id there
  // produces a number that looks like an answer, which is worse than no count
  // — the skill says so itself.
  for (const linter of LINTERS) {
    assert.ok(['id', 'entry'].includes(linter.placeholder), `${linter.name} must say what <RULE> is`);
  }

  const commitlint = detectLinters({ files: ['commitlint.config.mjs'], read: reader({}) })[0];
  assert.equal(commitlint.placeholder, 'entry');

  const withValue = countRecipe(commitlint, '"type-enum": [2, "always", ["feat", "fix"]]');
  assert.match(withValue, /\["feat", "fix"\]/, 'the value survives into the config');
  assert.doesNotMatch(withValue, /<RULE>/);

  // Everything else takes a plain id, and must not have grown a tuple.
  const eslint = detectLinters({ files: ['eslint.config.js'], read: reader({}) })[0];
  assert.equal(eslint.placeholder, 'id');
});

test('no recipe can silently install the tool it is counting with', () => {
  // `npx eslint` downloads whatever is latest when the project's own copy is
  // not installed, and a count from a different major version is a wrong
  // count. Failing loudly is the only honest outcome.
  for (const linter of LINTERS) {
    if (!linter.count.includes('npx ')) continue;
    assert.match(linter.count, /npx --no-install /, `${linter.name} must not fetch a linter`);
  }
});

test('every linter either resolves its configuration or says why it cannot', () => {
  // Detecting a config file says a linter is set up. It does not say which
  // rules are on, and proposing a rule the project already has is the one
  // thing this command exists to prevent. So every linter carries the
  // invocation that reports its *resolved* configuration — or, where the tool
  // has none, the reason, as data a reader can check rather than a silence.
  for (const linter of LINTERS) {
    assert.ok(
      ['run', 'config', 'none'].includes(linter.resolveKind),
      `${linter.name} has resolveKind ${linter.resolveKind}`,
    );
    if (linter.resolveKind === 'run') {
      assert.match(linter.resolve, /<FILE>/, `${linter.name} resolve substitutes nothing`);
      continue;
    }
    assert.equal(linter.resolve, null, `${linter.name} is not run but carries a recipe`);
    assert.ok(linter.resolveWhy?.length > 0, `${linter.name} does not resolve and says no reason`);
  }
});

test('no resolve or per-file recipe can silently install the tool it runs', () => {
  for (const linter of LINTERS) {
    for (const recipe of [linter.resolve, linter.lintFile]) {
      if (!recipe?.includes('npx ')) continue;
      assert.match(recipe, /npx --no-install /, `${linter.name} must not fetch a linter`);
    }
  }
});

test('the resolve recipe is the one the detected config actually takes', () => {
  const flat = detectLinters({ files: ['eslint.config.js'], read: reader({}) })[0];
  assert.equal(resolveRecipe(flat, 'src/index.ts'), 'npx --no-install eslint --print-config src/index.ts');

  // `--print-config` is spelled the same either side of the v9 flat-config
  // split, so unlike `count` there is no variant to pick — but the seam is
  // exercised anyway, because a variant added later must not silently apply.
  const legacy = detectLinters({ files: ['.eslintrc.json'], read: reader({}) })[0];
  assert.match(resolveRecipe(legacy, 'src/index.ts'), /--print-config src\/index\.ts$/);
  assert.doesNotMatch(resolveRecipe(legacy, 'src/index.ts'), /<FILE>/);
});

test('a linter that lints one file says how, and the rest say nothing rather than guessing', () => {
  // The edit hook runs this against the file that was just written. A linter
  // with no single-file invocation must produce no command at all: inventing
  // one is how a hook lints the whole repository on every keystroke.
  const byName = Object.fromEntries(LINTERS.map((l) => [l.name, l]));
  assert.match(byName.eslint.lintFile, /<FILE>/);
  assert.match(byName.biome.lintFile, /<FILE>/);
  // No formatter is named. ESLint 9 extracted every one but stylish, json and
  // html into its own package, so `--format=compact` is a dependency the
  // project may not have — and it failed on a real ESLint 9 exactly that way,
  // with the whole finding lost to the hook's own silence-on-failure rule.
  assert.doesNotMatch(byName.eslint.lintFile, /--format/);
  for (const linter of LINTERS) {
    if (linter.lintFile === null) continue;
    assert.match(linter.lintFile, /<FILE>/, `${linter.name} lintFile substitutes nothing`);
  }
});

test('the extension table is exported, because the edit hook decides from it too', () => {
  // A hook that keeps its own copy of "which extensions does eslint handle"
  // drifts from this one silently, and the drift shows up as a linter that
  // stopped running on a file type nobody noticed.
  for (const ext of ['.ts', '.tsx', '.mjs', '.py', '.go']) {
    assert.ok(LANGUAGE_BY_EXTENSION[ext], `${ext} names no language`);
  }
  assert.equal(LANGUAGE_BY_EXTENSION['.md'], undefined, 'markdown has no standard linter here');
});

test('a linter nothing names is reported as named by nothing', () => {
  // The finding is the empty case. A rule added to a linter that nothing runs
  // will never fail anything, and the project should hear that before it
  // spends an afternoon choosing rules.
  const files = ['biome.json', 'package.json'];
  const tree = { 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) };
  const linters = detectLinters({ files, read: reader(tree) });
  const found = detectInvocations({ files, read: reader(tree), linters });
  assert.deepEqual(found.biome, []);
});

test('a CI step that runs an npm script that runs the linter counts', () => {
  // `run: npm run lint` is how most projects actually invoke a linter. A
  // direct-name match alone reports every one of them as unenforced.
  const files = ['.github/workflows/ci.yml', 'eslint.config.mjs', 'package.json'];
  const tree = {
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }),
    '.github/workflows/ci.yml': 'jobs:\n  ci:\n    steps:\n      - run: npm run lint\n',
  };
  const linters = detectLinters({ files, read: reader(tree) });
  const where = detectInvocations({ files, read: reader(tree), linters }).eslint;

  const sites = where.map((w) => w.where);
  assert.ok(sites.includes('package.json#scripts.lint'), `direct: ${sites.join(', ')}`);
  assert.ok(sites.includes('.github/workflows/ci.yml'), `transitive: ${sites.join(', ')}`);
  assert.equal(where.find((w) => w.where.startsWith('.github')).via, 'npm run lint');
});

test('a husky hook and a pre-commit config name a linter as well as CI does', () => {
  const files = ['.husky/pre-commit', '.pre-commit-config.yaml', 'eslint.config.mjs', 'package.json'];
  const tree = {
    '.husky/pre-commit': 'npx eslint .\n',
    '.pre-commit-config.yaml': 'repos:\n  - hooks:\n      - id: eslint\n',
  };
  const linters = detectLinters({ files, read: reader(tree) });
  const sites = detectInvocations({ files, read: reader(tree), linters }).eslint.map((w) => w.where);
  assert.ok(sites.includes('.husky/pre-commit'));
  assert.ok(sites.includes('.pre-commit-config.yaml'));
});

test('a name inside a longer word is not an invocation', () => {
  // `eslint-config-acme` in a dependency list is not something running eslint.
  const files = ['eslint.config.mjs', 'package.json'];
  const tree = {
    'package.json': JSON.stringify({
      scripts: { build: 'tsc' },
      devDependencies: { 'eslint-config-acme': '^1.0.0' },
    }),
  };
  const linters = detectLinters({ files, read: reader(tree) });
  assert.deepEqual(detectInvocations({ files, read: reader(tree), linters }).eslint, []);
});

test('invocations are sorted, so the report they feed is stable', () => {
  const files = ['.github/workflows/ci.yml', '.husky/pre-commit', 'eslint.config.mjs', 'package.json'];
  const tree = {
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
    '.husky/pre-commit': 'npm run lint\n',
    '.github/workflows/ci.yml': '- run: npm run lint\n',
  };
  const linters = detectLinters({ files, read: reader(tree) });
  const run = () => detectInvocations({ files, read: reader(tree), linters }).eslint.map((w) => w.where);
  assert.deepEqual(run(), [...run()].sort());
  assert.deepEqual(run(), run());
});

test('every invocation site names a file or a directory, so a site is added as data', () => {
  for (const site of INVOCATION_SITES) {
    assert.ok(site.id?.length > 0);
    assert.ok(site.file || site.dir, `${site.id} names neither a file nor a directory`);
  }
});
