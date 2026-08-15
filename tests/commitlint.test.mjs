/**
 * The hook and commitlint must agree on what a valid commit type is.
 *
 * Two enforcement points now read the same convention from two different places:
 * hooks/check-commit-ticket.sh carries a `types=` alternation for the agent path,
 * and commitlint.config.mjs extends config-conventional for the husky path. A
 * commit that one accepts and the other rejects is the failure mode — the same
 * class of drift the CONFIG_FILES parity check in config.test.mjs exists for.
 *
 * The hook cannot import the config (it is bash, and must stay dependency-free),
 * so the two lists cannot be unified. Asserting they match is the next best
 * thing, and it fails loudly the moment either side is edited alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The `types='a|b|c'` default the hook falls back to with no config present. */
function hookTypes() {
  const src = readFileSync(join(ROOT, 'hooks', 'check-commit-ticket.sh'), 'utf8');
  const m = src.match(/^types='([^']+)'/m);
  assert.ok(m, "could not find the types='…' default in check-commit-ticket.sh");
  return m[1].split('|');
}

/** commitlint's resolved type-enum, read through its own loader. */
async function commitlintTypes() {
  const { default: load } = await import('@commitlint/load');
  const { rules } = await load({}, { cwd: ROOT });
  const [, , types] = rules['type-enum'];
  return types;
}

test('the hook and commitlint allow the same commit types', async () => {
  const fromHook = hookTypes();
  const fromCommitlint = await commitlintTypes();

  assert.deepEqual(
    [...fromHook].sort(),
    [...fromCommitlint].sort(),
    'hooks/check-commit-ticket.sh and commitlint.config.mjs disagree on commit types — ' +
      'a commit valid for one would be rejected by the other',
  );
});

test('the release-triggering types are among them', async () => {
  // Auto-versioning derives the bump from the type: feat -> minor, fix -> patch.
  // If either is ever dropped from the enum, releases stop happening silently.
  const types = hookTypes();
  for (const t of ['feat', 'fix']) {
    assert.ok(types.includes(t), `'${t}' must stay allowed — semantic-release derives the bump from it`);
  }
});
