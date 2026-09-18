/**
 * Which doctrine rules the project's linter already decides.
 *
 * The doctrine splits in two, and an A/B eval is what split it: the rules a
 * linter can decide scored the same with and without the doctrine in the
 * prompt, and the ones it cannot are where the whole gain came from. So a
 * mechanical rule belongs in the project's tooling and a semantic one belongs
 * in the prompt, and *which is which* has to be a table rather than a judgement
 * — a model asked to remember the split will propose a rule the project already
 * has, which is the one thing `/dev-lint-rules` exists to prevent.
 *
 * The registry is that table. These tests pin its shape, because the shape is
 * the interface a later ticket reads to know which bullets the prompt may drop.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coverageOf,
  DOCTRINE_RULES,
  DOCTRINE_TOOLS,
  parseBiomeConfig,
  renderDoctrine,
  renderSuggestion,
  stripJsonc,
  summarise,
} from '../lib/doctrine.mjs';
import { detectStack } from '../lib/stack.mjs';
import { TS_FULL } from './fixtures/stacks.mjs';

const LEVELS = new Set(['lint', 'proxy', 'doctrine-only']);

/** A reader over an in-memory tree, in the shape the readers take. */
const reader = (tree) => (path) => (path in tree ? tree[path] : null);

/** Every tool rule named anywhere in the registry, with its owner attached. */
const everyToolRule = () =>
  DOCTRINE_RULES.flatMap((rule) =>
    DOCTRINE_TOOLS.flatMap((tool) => (rule.tools[tool] ?? []).map((tr) => ({ rule, tool, tr }))),
  );

test('every doctrine rule has a stable id, a level and a statement', () => {
  const seen = new Set();
  for (const rule of DOCTRINE_RULES) {
    assert.match(rule.id, /^[a-z][a-z0-9-]*$/, `${rule.id} is not a kebab-case slug`);
    assert.equal(seen.has(rule.id), false, `${rule.id} is used twice`);
    seen.add(rule.id);

    assert.ok(LEVELS.has(rule.level), `${rule.id} has level ${rule.level}`);
    // `section` and `statement` are what make the report readable before the
    // doctrine text ships anywhere, and `why` is printed rather than being a
    // comment: a level nobody can argue with is a level nobody can correct.
    for (const field of ['section', 'statement', 'why']) {
      assert.equal(typeof rule[field], 'string', `${rule.id} has no ${field}`);
      assert.ok(rule[field].length > 0, `${rule.id} has an empty ${field}`);
    }
    assert.ok(['all', 'any'].includes(rule.satisfiedBy), `${rule.id} satisfiedBy ${rule.satisfiedBy}`);
  }
  assert.ok(DOCTRINE_RULES.length > 0);
});

test('the registry is sorted by id, so the report it feeds is stable', () => {
  const ids = DOCTRINE_RULES.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('a lint or proxy rule names at least one tool rule; a doctrine-only rule names none', () => {
  for (const rule of DOCTRINE_RULES) {
    const named = DOCTRINE_TOOLS.flatMap((tool) => rule.tools[tool] ?? []);
    if (rule.level === 'doctrine-only') {
      assert.equal(named.length, 0, `${rule.id} is doctrine-only but names ${named.length} tool rules`);
    } else {
      assert.ok(named.length > 0, `${rule.id} is ${rule.level} but names no tool rule`);
    }
  }
});

test('a tool with no equivalent says so, and is never silently absent', () => {
  // `null` on its own reads as "nobody got round to it". The reason is what
  // tells a reader the gap is real, and it is printed in the report — which is
  // also what a later ticket reads to know a bullet must stay in the prompt.
  for (const rule of DOCTRINE_RULES) {
    for (const tool of DOCTRINE_TOOLS) {
      assert.ok(tool in rule.tools, `${rule.id} says nothing at all about ${tool}`);
      if (rule.tools[tool] !== null) continue;
      const why = rule.absent?.[tool];
      assert.equal(typeof why, 'string', `${rule.id} has no ${tool} rule and no reason`);
      assert.ok(why.length > 0, `${rule.id} has an empty reason for ${tool}`);
    }
  }
});

test('every named tool rule carries the recipe that proves it exists', () => {
  // A rule id invented from memory is a config line that breaks somebody's
  // lint. `verify` is what turns that into an `unknown` verdict instead.
  for (const { rule, tool, tr } of everyToolRule()) {
    assert.ok(tr.id?.length > 0, `${rule.id}/${tool} names a rule with no id`);
    assert.ok(['error', 'warn'].includes(tr.severity), `${rule.id}/${tr.id} severity ${tr.severity}`);
    assert.equal(typeof tr.verify, 'string', `${rule.id}/${tr.id} has no verify recipe`);
    assert.match(tr.verify, /<FILE>|<RULE>/, `${rule.id}/${tr.id} verify substitutes nothing`);
  }
});

test('a threshold names the option it reads, so a new rule is data', () => {
  // `normaliseThreshold` reads both of ESLint's spellings off `numeric`. A
  // switch on rule id here would make every added rule a code change.
  for (const { rule, tr } of everyToolRule()) {
    if (!tr.threshold) continue;
    assert.equal(typeof tr.threshold.numeric, 'string', `${rule.id}/${tr.id} threshold names no option`);
    assert.ok(
      ['atMost', 'atLeast'].includes(tr.threshold.compare),
      `${rule.id}/${tr.id} threshold compares ${tr.threshold.compare}`,
    );
    assert.equal(typeof tr.threshold.bound, 'number', `${rule.id}/${tr.id} threshold has no bound`);
  }
});

test('no recipe in the registry can install the tool it asks about', () => {
  // The same refusal tests/rules.test.mjs makes of the count recipes: a probe
  // that installs a linter has changed the project it was only meant to read.
  for (const { rule, tr } of everyToolRule()) {
    if (!tr.verify.includes('npx ')) continue;
    assert.ok(
      tr.verify.includes('npx --no-install '),
      `${rule.id}/${tr.id} verify could install: ${tr.verify}`,
    );
  }
});

/** A resolved-configuration answer in the shape `coverageOf` takes. */
const resolvedWith = (rules, extra = {}) => ({ ok: true, source: 'run', rules, ...extra });

/** The one entry for `id`, with its evidence, out of a full coverage pass. */
const verdictFor = (id, input) => coverageOf(input).find((r) => r.id === id);

test('a resolved configuration decides covered, partial and missing per doctrine rule', () => {
  const input = {
    tools: ['eslint'],
    resolved: {
      eslint: resolvedWith({
        'max-params': ['warn', { max: 2 }],
        complexity: ['warn', { max: 8 }],
        'id-length': ['warn', { min: 3 }],
      }),
    },
  };
  assert.equal(verdictFor('options-objects', input).verdict, 'covered');
  assert.equal(verdictFor('one-job-per-function', input).verdict, 'covered', 'satisfiedBy any');
  assert.equal(verdictFor('full-word-naming', input).verdict, 'covered', 'satisfiedBy any');
  assert.equal(verdictFor('result-types', input).verdict, 'missing');
});

test('a rule present but weaker than the suggestion is partial, not covered', () => {
  const weaker = {
    tools: ['eslint'],
    resolved: { eslint: resolvedWith({ 'max-params': ['warn', { max: 6 }] }) },
  };
  const entry = verdictFor('options-objects', weaker);
  assert.equal(entry.verdict, 'partial');
  assert.equal(entry.evidence[0].weaker, true);
  assert.equal(entry.evidence[0].found, 6);
});

test('both of ESLint’s option spellings read the same', () => {
  // `['warn', 2]` and `['warn', {max: 2}]` are the same configuration, and a
  // reader that knows only one of them reports half the projects as missing.
  const positional = { tools: ['eslint'], resolved: { eslint: resolvedWith({ 'max-params': ['warn', 2] }) } };
  const keyed = { tools: ['eslint'], resolved: { eslint: resolvedWith({ 'max-params': ['warn', { max: 2 }] }) } };
  assert.equal(verdictFor('options-objects', positional).verdict, 'covered');
  assert.equal(verdictFor('options-objects', keyed).verdict, 'covered');
  assert.equal(verdictFor('options-objects', positional).evidence[0].found, 2);
});

test('a rule configured off is missing, not covered', () => {
  for (const off of ['off', 0, ['off'], [0]]) {
    const input = { tools: ['eslint'], resolved: { eslint: resolvedWith({ 'max-params': off }) } };
    const entry = verdictFor('options-objects', input);
    assert.equal(entry.verdict, 'missing', `${JSON.stringify(off)} should read as missing`);
    assert.match(entry.evidence[0].reason, /off/);
  }
});

test('a resolve that failed is unknown, and nothing is proposed for it', () => {
  // Contract rule 2: a guess that is usually right is worse than an error,
  // because the times it is wrong are silent. "Could not find out" is not
  // evidence that a rule is absent, and proposing one the project already has
  // is exactly what this command exists to prevent.
  const input = {
    tools: ['eslint'],
    resolved: { eslint: { ok: false, reason: 'eslint is configured but not installed' } },
  };
  for (const id of ['options-objects', 'result-types', 'one-job-per-function']) {
    const entry = verdictFor(id, input);
    assert.equal(entry.verdict, 'unknown', `${id} should be unknown`);
    assert.equal(entry.evidence.every((e) => e.present === 'unknown'), true);
    assert.match(entry.evidence[0].reason, /not installed/);
  }
});

test('a type-aware rule in a project with no parser project is unknown, not missing', () => {
  // Without type information those rules cannot be enabled at all, so calling
  // them missing hands the project a suggestion it cannot apply.
  const noTypes = {
    tools: ['eslint', 'typescriptEslint'],
    resolved: {
      eslint: resolvedWith({ 'no-empty': ['error', { allowEmptyCatch: false }] }),
      typescriptEslint: resolvedWith({ 'no-empty': ['error'] }, { typeAware: false }),
    },
  };
  const entry = verdictFor('error-discipline', noTypes);
  assert.equal(entry.verdict, 'unknown');
  const typed = entry.evidence.filter((e) => e.tool === 'typescriptEslint');
  assert.equal(typed.length, 2);
  assert.equal(typed.every((e) => e.present === 'unknown'), true);
  assert.match(typed[0].reason, /type information|parser project/i);
});

test('satisfiedBy all needs every rule; satisfiedBy any needs one', () => {
  const one = {
    tools: ['eslint', 'typescriptEslint'],
    resolved: {
      eslint: resolvedWith({ 'no-empty': ['error'], complexity: ['warn', { max: 8 }] }),
      typescriptEslint: resolvedWith({ 'no-empty': ['error'] }, { typeAware: true }),
    },
  };
  // error-discipline is `all`: no-empty alone leaves the two typed rules absent.
  assert.equal(verdictFor('error-discipline', one).verdict, 'partial');
  // one-job-per-function is `any`: complexity alone is enough.
  assert.equal(verdictFor('one-job-per-function', one).verdict, 'covered');
});

test('a rule no configured linter can express is missing, and proposes nothing', () => {
  // A Biome project cannot express result-types at all — Biome has no
  // arbitrary-AST-selector rule. Reporting that is useful; proposing ESLint
  // rules to a Biome project is the second linter this skill refuses to add.
  const biomeOnly = { tools: ['biome'], resolved: { biome: resolvedWith({}, { source: 'config' }) } };
  const entry = verdictFor('result-types', biomeOnly);
  assert.equal(entry.verdict, 'missing');
  assert.equal(entry.expressible, false);
  assert.equal(renderSuggestion(entry, { dialect: 'biome' }), null);
  assert.match(entry.reason, /no arbitrary-AST-selector rule/);
});

test('a doctrine-only rule is named with its reason and never proposed', () => {
  // This is the entry a later ticket reads to know the bullet must stay in the
  // prompt, so it has to survive as its own verdict rather than as a silence.
  const entry = verdictFor('cleanup-symmetry', { tools: ['eslint'], resolved: { eslint: resolvedWith({}) } });
  assert.equal(entry.verdict, 'doctrine-only');
  assert.equal(entry.evidence.length, 0);
  assert.equal(renderSuggestion(entry, { dialect: 'flat' }), null);
  assert.match(entry.why, /lifetime of a registration/);
});

test('coverage is sorted by id and counted, whatever order the input arrived in', () => {
  const input = { tools: ['eslint'], resolved: { eslint: resolvedWith({ 'max-params': ['warn', { max: 2 }] }) } };
  const ids = coverageOf(input).map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort());

  const counts = summarise(coverageOf(input));
  const total = counts.covered + counts.partial + counts.missing + counts.unknown + counts.doctrineOnly;
  assert.equal(total, DOCTRINE_RULES.length);
  assert.equal(counts.covered, 1);
  assert.equal(counts.doctrineOnly, 1);
});

test('the snippet is written in the dialect the found config actually uses', () => {
  const missing = { id: 'result-types', verdict: 'missing', expressible: true, evidence: [] };

  const flat = renderSuggestion(missing, { dialect: 'flat' });
  assert.match(flat, /^'no-restricted-syntax': \['warn', \{ selector: 'ThrowStatement'/);

  const legacy = renderSuggestion(missing, { dialect: 'eslintrc' });
  // A legacy config is JSON. Single-quoted keys pasted into it are a syntax
  // error, which is how a "helpful" snippet breaks somebody's lint.
  assert.match(legacy, /^"no-restricted-syntax": \["warn",/);
  assert.doesNotMatch(legacy, /'/, 'an eslintrc snippet must carry no flat-config syntax');
});

test('a biome snippet nests its rule under the group biome files it under', () => {
  const missing = { id: 'error-discipline', verdict: 'missing', expressible: true, evidence: [] };
  const snippet = renderSuggestion(missing, { dialect: 'biome' });
  assert.match(snippet, /"suspicious"/);
  assert.match(snippet, /"noEmptyBlockStatements": "error"/);
  // The group is the nesting, not part of the name.
  assert.doesNotMatch(snippet, /"suspicious\/noEmptyBlockStatements"/);
});

test('a rule already present is not proposed again, even when its neighbours are missing', () => {
  // The whole point of resolving the configuration: a partial verdict proposes
  // the half that is absent and leaves the half that is there alone.
  const partial = {
    id: 'error-discipline',
    verdict: 'partial',
    expressible: true,
    evidence: [
      { tool: 'eslint', rule: 'no-empty', present: true, weaker: false },
      { tool: 'typescriptEslint', rule: '@typescript-eslint/no-floating-promises', present: false },
      { tool: 'typescriptEslint', rule: '@typescript-eslint/only-throw-error', present: false },
    ],
  };
  const snippet = renderSuggestion(partial, { dialect: 'flat' });
  assert.doesNotMatch(snippet, /'no-empty'/);
  assert.match(snippet, /no-floating-promises/);
  assert.match(snippet, /only-throw-error/);
});

test('nothing is proposed for a covered rule or for one whose answer is unknown', () => {
  for (const verdict of ['covered', 'unknown']) {
    const entry = { id: 'options-objects', verdict, expressible: true, evidence: [] };
    assert.equal(renderSuggestion(entry, { dialect: 'flat' }), null, `${verdict} proposed something`);
  }
});

test('a rule needing the project’s own input emits a placeholder and invents nothing', () => {
  // `no-restricted-imports` with a module list invented here is a rule that
  // flags the wrong thing forever, and nobody goes back to check it.
  const entry = { id: 'injection-for-testability', verdict: 'missing', expressible: true, evidence: [] };
  const snippet = renderSuggestion(entry, { dialect: 'flat' });
  assert.match(snippet, /<the module this layer must not reach for directly>/);
});

test('a jsonc config with comments and a trailing comma parses', () => {
  const text = `{
  // biome's own docs write configs this way
  "linter": {
    "rules": {
      "suspicious": { "noEmptyBlockStatements": "error" }, /* and this way */
    },
  },
}`;
  const parsed = stripJsonc(text);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(JSON.parse(parsed.text).linter.rules.suspicious.noEmptyBlockStatements, 'error');
});

test('a jsonc reader that is not certain says so, and names the line', () => {
  // `lib/architecture.mjs` established this: a parser that is usually right is
  // worse than one that says no, because the times it is wrong are silent.
  const parsed = stripJsonc('{\n  "a": 1,\n  "b": "unterminated\n}');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.line, 3);
});

test('a // inside a string is not a comment', () => {
  const parsed = stripJsonc('{"url": "https://example.com/x", "n": 1}');
  assert.equal(parsed.ok, true);
  assert.equal(JSON.parse(parsed.text).url, 'https://example.com/x');
});

test('biome coverage is read from its config, and the answer says so', () => {
  const answer = parseBiomeConfig({
    files: ['biome.json'],
    read: reader({
      'biome.json': JSON.stringify({
        linter: { enabled: true, rules: { suspicious: { noEmptyBlockStatements: 'error' } } },
      }),
    }),
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.source, 'config', 'biome has no --print-config; the report must not claim it ran one');
  assert.equal(answer.rules['suspicious/noEmptyBlockStatements'], 'error');
});

test('a rule biome recommends counts as present when the preset is on', () => {
  const on = parseBiomeConfig({
    files: ['biome.json'],
    read: reader({ 'biome.json': JSON.stringify({ linter: { rules: { recommended: true } } }) }),
  });
  assert.equal(on.ok, true);
  // complexity/noExcessiveCognitiveComplexity is not recommended, so the preset
  // alone must not make it present — otherwise every biome project reads as
  // covered for a rule it has never switched on.
  assert.equal(on.rules['complexity/noExcessiveCognitiveComplexity'], undefined);
});

test('the linter being off means no rule is on, whatever the rules block says', () => {
  const answer = parseBiomeConfig({
    files: ['biome.json'],
    read: reader({
      'biome.json': JSON.stringify({
        linter: { enabled: false, rules: { suspicious: { noEmptyBlockStatements: 'error' } } },
      }),
    }),
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.rules, {});
  assert.match(answer.note, /linter is disabled/);
});

test('a relative extends is followed, child over parent, and a cycle terminates', () => {
  const answer = parseBiomeConfig({
    files: ['biome.json', 'base.json'],
    read: reader({
      'biome.json': JSON.stringify({
        extends: ['./base.json'],
        linter: { rules: { suspicious: { noEmptyBlockStatements: 'off' } } },
      }),
      'base.json': JSON.stringify({
        extends: ['./biome.json'],
        linter: { rules: { suspicious: { noEmptyBlockStatements: 'error' }, complexity: { noBannedTypes: 'warn' } } },
      }),
    }),
  });
  assert.equal(answer.ok, true, answer.reason);
  assert.equal(answer.rules['suspicious/noEmptyBlockStatements'], 'off', 'the child wins');
  assert.equal(answer.rules['complexity/noBannedTypes'], 'warn', 'the parent still contributes');
});

test('an extends we cannot follow makes the answer unknown, naming what it is', () => {
  // Resolving an npm specifier means node module resolution against the
  // project's node_modules, which is a different kind of read. Quietly treating
  // the base config as absent would report every rule it sets as missing.
  const answer = parseBiomeConfig({
    files: ['biome.json'],
    read: reader({ 'biome.json': JSON.stringify({ extends: ['@acme/biome-config'] }) }),
  });
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /@acme\/biome-config/);
});

test('no biome config at all is not an error, and is not a coverage answer either', () => {
  const answer = parseBiomeConfig({ files: ['package.json'], read: reader({}) });
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /no biome config/i);
});

/** A whole report's input, with the awkward parts already set up. */
const reportInput = () => {
  const coverage = coverageOf({
    tools: ['eslint', 'typescriptEslint'],
    resolved: {
      eslint: resolvedWith({ 'max-params': ['warn', { max: 6 }], 'no-empty': ['error'] }),
      typescriptEslint: resolvedWith({ 'no-empty': ['error'] }, { typeAware: false }),
    },
  });
  return {
    stack: detectStack({ files: TS_FULL.files, read: reader(TS_FULL.tree) }),
    tooling: [
      {
        name: 'eslint',
        language: 'JavaScript, TypeScript',
        configs: ['eslint.config.mjs'],
        dialect: 'flat',
        installed: true,
        namedIn: [{ site: 'npm-scripts', where: 'package.json#scripts.lint', via: 'direct' }],
        resolve: { source: 'run', ok: true, target: 'src/index.ts', command: 'npx --no-install eslint --print-config src/index.ts' },
      },
    ],
    coverage,
    summary: summarise(coverage),
  };
};

test('the doctrine report is a pure function of its input', () => {
  // Contract rule 4. Two runs on an unchanged tree must print the same bytes,
  // or a report is a thing you cannot diff and therefore cannot trust.
  const input = reportInput();
  assert.equal(renderDoctrine(input), renderDoctrine(input));

  const shuffled = { ...input, coverage: [...input.coverage].reverse() };
  assert.equal(renderDoctrine(shuffled), renderDoctrine(input), 'input order must not reach the output');
});

test('the report carries no absolute path, so two checkouts print the same bytes', () => {
  assert.doesNotMatch(renderDoctrine(reportInput()), /\/Users\/|\/home\//);
});

test('the report says a linter is named in something, never that it runs', () => {
  // A word match proves the name appears. A commented-out CI step matches too,
  // so the weaker claim is the true one and the heading says the weaker claim.
  const out = renderDoctrine(reportInput());
  assert.match(out, /named in/);
  assert.doesNotMatch(out, /runs in/);
});

test('a linter nothing names is called out rather than listed blank', () => {
  const input = reportInput();
  input.tooling[0].namedIn = [];
  assert.match(renderDoctrine(input), /never fail anything/);
});

test('the report says which kind of answer each tool gave', () => {
  // Running the tool and reading its config are different claims, and a reader
  // must never have to work out which one they got.
  const input = reportInput();
  assert.match(renderDoctrine(input), /resolved by running/);

  input.tooling[0] = {
    ...input.tooling[0],
    name: 'biome',
    dialect: 'biome',
    configs: ['biome.json'],
    resolve: { source: 'config', ok: true },
  };
  assert.match(renderDoctrine(input), /read from biome\.json/);
});

test('an unknown verdict prints what would make it knowable, and proposes nothing', () => {
  const coverage = coverageOf({
    tools: ['eslint'],
    resolved: { eslint: { ok: false, reason: 'eslint is configured but not installed' } },
  });
  const out = renderDoctrine({
    stack: detectStack(),
    tooling: [
      {
        name: 'eslint',
        language: 'JavaScript, TypeScript',
        configs: ['eslint.config.mjs'],
        dialect: 'flat',
        installed: false,
        namedIn: [],
        resolve: { source: 'run', ok: false, reason: 'eslint is configured but not installed' },
      },
    ],
    coverage,
    summary: summarise(coverage),
  });
  assert.match(out, /not installed/);
  assert.doesNotMatch(out, /suggestions \(/, 'nothing may be proposed on an answer we do not have');
});

test('a legacy eslintrc is flagged once, and the snippets stay in its dialect', () => {
  const input = reportInput();
  input.tooling[0] = { ...input.tooling[0], configs: ['.eslintrc.json'], dialect: 'eslintrc' };
  const out = renderDoctrine(input);
  assert.match(out, /not migrated/);
  assert.match(out, /"max-params": \["warn"/, 'the snippet must be pasteable into the config that is there');
});

test('a doctrine-only rule is named in the report with its reason, and nowhere else', () => {
  const out = renderDoctrine(reportInput());
  assert.match(out, /cleanup-symmetry/);
  assert.match(out, /lifetime of a registration/);
  const suggestions = out.slice(out.indexOf('suggestions'));
  assert.doesNotMatch(suggestions, /cleanup-symmetry/);
});

test('a caveat travels with the suggestion it qualifies', () => {
  // A rule that flags four hundred existing throws is a decision, not a config
  // line, and the caveat is what makes it one.
  assert.match(renderDoctrine(reportInput()), /read the count before switching it on/);
});

test('two doctrine rules proposing one tool rule are merged, not printed twice', () => {
  // ESLint's no-restricted-syntax takes every selector in ONE entry. Printing
  // it twice in the same rules object means the second silently replaces the
  // first, so a project that pastes both suggestions gets one of them and no
  // warning — a config line that quietly does half of what it claims.
  const coverage = coverageOf({
    tools: ['eslint'],
    resolved: { eslint: resolvedWith({}) },
  });
  const out = renderDoctrine({
    stack: detectStack(),
    tooling: [{ name: 'eslint', configs: ['eslint.config.mjs'], dialect: 'flat', installed: true, namedIn: [], resolve: { source: 'run', ok: true } }],
    coverage,
    summary: summarise(coverage),
  });

  const suggestions = out.slice(out.indexOf('suggestions'));
  const occurrences = suggestions.split(/'no-restricted-syntax':/).length - 1;
  assert.equal(occurrences, 1, 'no-restricted-syntax must be proposed exactly once');
  // And the one entry must carry both selectors, or merging lost one of them.
  assert.match(suggestions, /ThrowStatement/);
  assert.match(suggestions, /TSBooleanKeyword/);
  // The reader has to be able to see which doctrine rules the merged entry serves.
  assert.match(suggestions, /result-types/);
  assert.match(suggestions, /boolean-behaviour-params/);
});

test('a rule satisfied by any one of a family says so, rather than reading as a contradiction', () => {
  // `complexity ✓ · max-statements ✗` under the heading "covered" reads as a
  // mistake unless the report says one is enough.
  const coverage = coverageOf({
    tools: ['eslint'],
    resolved: { eslint: resolvedWith({ complexity: ['warn', { max: 8 }] }) },
  });
  const entry = coverage.find((r) => r.id === 'one-job-per-function');
  assert.equal(entry.verdict, 'covered');
  const out = renderDoctrine({
    stack: detectStack(),
    tooling: [],
    coverage,
    summary: summarise(coverage),
  });
  assert.match(out, /any one of these/);
});

test('a project with no linter at all is told which tool could decide a rule', () => {
  // And told it as a sentence. The first draft ended this one with "eslint
  // can, and " — the branch assumed at least one linter was configured, and a
  // dangling clause is how a reader learns to stop reading the reasons.
  const coverage = coverageOf({ tools: [], resolved: {} });
  for (const entry of coverage) {
    if (entry.verdict === 'doctrine-only') continue;
    assert.equal(entry.expressible, false);
    assert.doesNotMatch(entry.reason, /,\s*$|\sand\s*$/, `${entry.id}: ${entry.reason}`);
    assert.match(entry.reason, /no linter is configured/);
  }
  const options = coverage.find((r) => r.id === 'options-objects');
  assert.match(options.reason, /eslint could decide it/);
});

test('a project whose linter cannot express a rule is told what its linter lacks', () => {
  const coverage = coverageOf({ tools: ['biome'], resolved: { biome: resolvedWith({}) } });
  const entry = coverage.find((r) => r.id === 'options-objects');
  assert.match(entry.reason, /biome has no max-params equivalent/);
  assert.doesNotMatch(entry.reason, /,\s*$|\sand\s*$/);
});
