import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintInventory } from './lint-inventory.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lint-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const put = (path, content = 'export {};\n') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git('init', '-q');
  for (const name of ['lint.sh', 'lint-inventory.mjs']) {
    put(`tests/${name}`);
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(root, 'tests', name));
  }
  const lint = () => spawnSync('bash', ['tests/lint.sh'], { cwd: root, encoding: 'utf8' });
  return { root, git, put, lint };
}

test('inventory matches Git-owned scripts and retains payload and top-level Husky hooks', t => {
  const { root, git, put, lint } = fixture(t);
  put('src/tracked.mjs');
  put('.husky/helpers/check.mjs');
  put('_dev-workflow/scripts/dev.mjs');
  put('.husky/commit-msg', '#!/bin/sh\nexit 0\n');
  put('deleted.mjs');
  put('README.md', 'hello');
  git('add', '.');
  rmSync(join(root, 'deleted.mjs'));
  put('src/new.mjs');
  put('.gitignore', 'ignored/\n');
  put('ignored/bad.mjs', 'const =');
  const inventory = lintInventory(root);
  const expected = git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0').filter(p => p && p !== 'deleted.mjs' && (p.endsWith('.mjs') || p.endsWith('.sh') || p === '.husky/commit-msg')).sort();
  assert.deepEqual(inventory, expected);
  assert.equal(lint().status, 0);
  put('.husky/commit-msg', 'if then\n');
  assert.notEqual(lint().status, 0);
  put('.husky/commit-msg', '#!/bin/sh\nexit 0\n');
  put('_dev-workflow/scripts/dev.mjs', 'const =');
  assert.notEqual(lint().status, 0);
});

test('untracked source syntax errors are caught with spaces and newlines in paths', t => {
  const { root, put, lint } = fixture(t);
  for (const path of ['src/new file.mjs', 'src/new\nfile.mjs', 'src/shell\nfile.sh']) {
    put(path, path.endsWith('.sh') ? 'if then\n' : 'const =');
    assert.ok(lintInventory(root).includes(path));
    const result = lint();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`FAIL ./${path}`));
    put(path, path.endsWith('.sh') ? '#!/bin/sh\nexit 0\n' : 'export {};\n');
  }
  assert.equal(lint().status, 0);
});

test('nested worktrees, Git repositories, dependencies and Husky runtime are excluded', t => {
  const { root, git, put, lint } = fixture(t);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  git('worktree', 'add', '--detach', 'nested/checkout', 'HEAD');
  put('nested/checkout/bad.mjs', 'const =');
  put('nested/repository/bad.mjs', 'const =');
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'nested/repository') });
  for (const path of ['node_modules/bad.mjs', 'nested/node_modules/bad.mjs', '.husky/_/bad.sh', 'nested/.husky/_/bad.sh', '.worktrees/bad.mjs']) put(path, 'const =');
  // Even force-tracked dependency/runtime files do not belong to the gate.
  git('add', '-f', 'nested/node_modules/bad.mjs', '.husky/_/bad.sh');
  symlinkSync('nested/checkout/bad.mjs', join(root, 'linked.mjs'));
  assert.deepEqual(lintInventory(root), ['tests/lint-inventory.mjs', 'tests/lint.sh']);
  assert.equal(lint().status, 0);
});

test('Git inventory failure fails the gate rather than reporting a clean empty checkout', t => {
  const { root, lint } = fixture(t);
  rmSync(join(root, '.git'), { recursive: true, force: true });
  const result = lint();
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('lint: clean'));
});
