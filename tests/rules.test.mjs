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
  detectLinters,
  languagesOf,
  LINTERS,
  renderRules,
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
