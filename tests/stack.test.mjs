/**
 * What a project declares it is built with.
 *
 * A stack is read off what a project **declares** — a dependency, a tsconfig, a
 * workspace list — never off a directory name. `src/react/` is a folder; a
 * `react` dependency is a fact, and the difference is whether the answer
 * survives somebody tidying up.
 *
 * The reader is injected for the reason every reader in `lib/` is: a detector
 * that needs a repository on disk cannot be asserted against the awkward cases,
 * and the awkward cases are the whole job.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectStack, STACK_SIGNALS, WORKSPACE_SIGNALS } from '../lib/stack.mjs';
import { BIOME, FIXTURES, MONO, NO_STACK, reader, TS_BARE, TS_FULL } from './fixtures/stacks.mjs';

/** Run the detector over one of the shared fixtures. */
const detect = (fixture) => detectStack({ files: fixture.files, read: reader(fixture.tree) });

test('a TypeScript project is read off package.json and tsconfig, with its strict flags', () => {
  const stack = detect(TS_FULL);
  assert.equal(stack.typescript.present, true);
  assert.equal(stack.typescript.declared, '^5.6.2');
  assert.equal(stack.typescript.strict, true);
  // strictNullChecks and noImplicitAny are part of the strict family, so
  // `strict: true` switches them on without naming them. The other two are
  // not, and a config that does not name them has them off.
  assert.equal(stack.typescript.flags.strictNullChecks, true);
  assert.equal(stack.typescript.flags.noImplicitAny, true);
  assert.equal(stack.typescript.flags.noUncheckedIndexedAccess, false);
  assert.equal(stack.typescript.flags.exactOptionalPropertyTypes, false);
});

test('frameworks come from dependencies, never from a directory name', () => {
  assert.deepEqual(detect(TS_FULL).frameworks, ['next', 'react']);
  assert.deepEqual(detect(TS_BARE).frameworks, []);
});

test('a declared package is reported with the range the project asked for', () => {
  const declared = Object.fromEntries(detect(TS_FULL).declared.map((d) => [d.id, d.range]));
  assert.equal(declared.typescript, '^5.6.2');
  assert.equal(declared.next, '^15.0.0');
});

test('typescript-eslint is a tool the project declares, not one inferred from eslint', () => {
  // Its rules need a parser project to run at all, so treating it as a flavour
  // of eslint hands a project suggestions it cannot apply.
  assert.equal(detect(TS_FULL).typescriptEslint, true);
  assert.equal(detect(TS_BARE).typescriptEslint, false);
});

test('a tsconfig that extends another reports strict as unknown, naming the spec', () => {
  // Following it means node module resolution against the project's
  // node_modules, which is a different kind of read. Reporting `strict: false`
  // for a project that extends @tsconfig/strictest is the silent wrong answer.
  const stack = detectStack({
    files: ['package.json', 'tsconfig.json'],
    read: reader({
      'package.json': '{"devDependencies":{"typescript":"^5.6.2"}}',
      'tsconfig.json': '{"extends":"@tsconfig/strictest/tsconfig.json"}',
    }),
  });
  assert.equal(stack.typescript.strict, 'unknown');
  assert.equal(stack.typescript.extends, '@tsconfig/strictest/tsconfig.json');
});

test('a tsconfig with comments and a trailing comma is read, not refused', () => {
  const stack = detectStack({
    files: ['tsconfig.json'],
    read: reader({ 'tsconfig.json': '{\n  // tsc allows this\n  "compilerOptions": { "strict": true, },\n}' }),
  });
  assert.equal(stack.typescript.strict, true);
});

test('workspaces are read from every signal a repo might use', () => {
  const stack = detect(MONO);
  assert.equal(stack.workspaces.kind, 'workspaces');
  assert.deepEqual(stack.workspaces.tools, ['npm', 'pnpm', 'turbo']);
  assert.deepEqual(stack.workspaces.packages, ['packages/*', 'tools/*']);
});

test('a single-package repo says so rather than saying nothing', () => {
  assert.equal(detect(TS_FULL).workspaces.kind, 'single');
});

test('an unreadable workspace file abstains rather than reporting no packages', () => {
  // "No packages" and "we could not tell" are different answers, and only one
  // of them is true here. Reporting the wrong one makes a monorepo read as a
  // single package and every package but the root go unexamined.
  const stack = detectStack({
    files: ['pnpm-workspace.yaml'],
    read: reader({ 'pnpm-workspace.yaml': 'packages: !!binary |\n  Zm9v\n' }),
  });
  assert.equal(stack.workspaces.kind, 'workspaces');
  assert.equal(stack.workspaces.packages, 'unknown');
});

test('a tree with no recognised stack reports none, and names nothing', () => {
  const stack = detect(NO_STACK);
  assert.equal(stack.typescript.present, false);
  assert.deepEqual(stack.frameworks, []);
  assert.deepEqual(stack.declared, []);
  assert.equal(stack.workspaces.kind, 'single');
});

test('detection never throws when the reader answers null for everything', () => {
  // Every file may be unreadable — a dangling symlink, a permission, a path
  // that is tracked but not checked out. None of that is an error here.
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    assert.doesNotThrow(() => detectStack({ files: fixture.files, read: () => null }), name);
  }
  assert.doesNotThrow(() => detectStack());
});

test('the output is stable, so the report it feeds is too', () => {
  assert.deepEqual(detect(BIOME), detect(BIOME));
  assert.deepEqual(detect(MONO).workspaces.tools, [...detect(MONO).workspaces.tools].sort());
});

test('every signal names what it would contribute, so a stack is added as data', () => {
  for (const signal of STACK_SIGNALS) {
    assert.match(signal.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(['dependency', 'file'].includes(signal.kind), `${signal.id} has kind ${signal.kind}`);
    assert.ok(signal.language || signal.framework, `${signal.id} contributes nothing`);
  }
  for (const signal of WORKSPACE_SIGNALS) {
    assert.ok(signal.file?.length > 0, `${signal.id} names no file`);
  }
});
