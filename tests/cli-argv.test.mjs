/**
 * The installer's command line: subcommands for a binary installed once, and
 * the flags every documented `npx …` line already uses. One parser, so
 * `claude-dev-workflow update` and `npx claude-dev-workflow@latest --update`
 * are two spellings of one path, never two paths.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCommand } from '../bin/lib/argv.mjs';

test('bare is init, and init is bare', () => {
  assert.equal(parseCommand([]).command, 'init');
  assert.equal(parseCommand(['init']).command, 'init');
  assert.equal(parseCommand(['init', '--print']).flags.print, true);
});

test('update is --update, with --reconfigure either way', () => {
  assert.deepEqual(parseCommand(['update']).command, 'update');
  assert.equal(parseCommand(['--update']).command, 'update');
  assert.equal(parseCommand(['update', '--reconfigure']).flags.reconfigure, true);
  assert.equal(parseCommand(['--update', '--reconfigure']).flags.reconfigure, true);
  assert.equal(parseCommand(['update']).flags.reconfigure, false);
});

test('version and help are their own commands, and the old flags still spell them', () => {
  assert.equal(parseCommand(['version']).command, 'version');
  assert.equal(parseCommand(['--version']).command, 'version');
  assert.equal(parseCommand(['help']).command, 'help');
  assert.equal(parseCommand(['--help']).command, 'help');
  assert.equal(parseCommand(['-h']).command, 'help');
});

test('--dir, --print and --force are read wherever they sit', () => {
  const r = parseCommand(['update', '--dir', '../x', '--force', '--print']);
  assert.equal(r.flags.dir, '../x');
  assert.equal(r.flags.force, true);
  assert.equal(r.flags.print, true);
  assert.equal(parseCommand(['--dir', 'here']).flags.dir, 'here');
  assert.equal(parseCommand([]).flags.dir, null);
});

test('an unknown subcommand is an error naming it, not a wizard', () => {
  const r = parseCommand(['instal']);
  assert.equal(r.command, 'error');
  assert.match(r.error, /instal/);
  assert.match(r.error, /init, update, version, help/);
});

test('a --dir with no value is an error, not the cwd', () => {
  const r = parseCommand(['update', '--dir']);
  assert.equal(r.command, 'error');
  assert.match(r.error, /--dir/);
});
