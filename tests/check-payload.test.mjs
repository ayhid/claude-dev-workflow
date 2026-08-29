/**
 * The source-vs-copy check (repo-local dev tooling, not shipped).
 *
 * This repo is one of its own consumers: `_dev-workflow/` and
 * `.claude/skills/dev-*` are an installed copy of `lib/`, `scripts/`, `hooks/`
 * and `skills/`, and the copy is what actually runs. Keeping the two in step
 * was manual until this check existed.
 *
 * Everything here runs against a temporary tree built in `mkdtemp`. Asserting
 * against this repo's own installed copy would make the suite depend on
 * whether someone had refreshed it, which is the very thing under test.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkPayload } from '../tools/check-payload.mjs';

/** Write `body` at `rel` under `root`, creating parents. */
function put(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/**
 * A miniature of this repo: the four payload source directories, plus the
 * installed copy the installer would have written from them.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'payload-check-'));

  const sources = [
    ['lib/thing.mjs', 'export const thing = 1;\n'],
    ['scripts/dev.mjs', '#!/usr/bin/env node\n'],
    ['hooks/guard.sh', '#!/usr/bin/env bash\n'],
  ];
  for (const [rel, body] of sources) {
    put(root, rel, body);
    put(root, join('_dev-workflow', rel), body);
  }

  put(root, 'skills/dev-thing/SKILL.md', '# dev-thing\n');
  put(root, '.claude/skills/dev-thing/SKILL.md', '# dev-thing\n');

  return root;
}

test('AC3: a copy regenerated from the source reports no drift', () => {
  const root = fixture();
  assert.deepEqual(checkPayload({ sourceRoot: root }), { stale: [], missing: [], orphan: [] });
});

test('AC4: a source edited with the installed copy untouched is stale, by name', () => {
  const root = fixture();
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  const { stale, missing, orphan } = checkPayload({ sourceRoot: root });
  assert.deepEqual(stale, [join('_dev-workflow', 'lib', 'thing.mjs')]);
  assert.deepEqual(missing, []);
  assert.deepEqual(orphan, []);
});

test('AC5: a planned file absent from the installed tree is missing, by name', () => {
  const root = fixture();
  rmSync(join(root, '_dev-workflow', 'hooks', 'guard.sh'));

  const { stale, missing } = checkPayload({ sourceRoot: root });
  assert.deepEqual(missing, [join('_dev-workflow', 'hooks', 'guard.sh')]);
  assert.deepEqual(stale, []);
});

test('AC4/AC5: a skill is compared the same way as the payload', () => {
  // Skills land somewhere else entirely — `.claude/skills/`, not
  // `_dev-workflow/` — so a check that only walked the payload directory would
  // pass here while the skills the agent actually loads were stale.
  const root = fixture();
  put(root, 'skills/dev-thing/SKILL.md', '# dev-thing, rewritten\n');

  assert.deepEqual(checkPayload({ sourceRoot: root }).stale, [
    join('.claude', 'skills', 'dev-thing', 'SKILL.md'),
  ]);
});

test('AC6: an unplanned file under an owned root is an orphan', () => {
  const root = fixture();
  put(root, '_dev-workflow/lib/gone.mjs', 'export const gone = 1;\n');
  put(root, '.claude/skills/dev-thing/OLD.md', '# removed\n');

  const { orphan, stale, missing } = checkPayload({ sourceRoot: root });
  assert.deepEqual(orphan, [
    join('.claude', 'skills', 'dev-thing', 'OLD.md'),
    join('_dev-workflow', 'lib', 'gone.mjs'),
  ]);
  assert.deepEqual(stale, []);
  assert.deepEqual(missing, []);
});

test('AC6: the installer\'s own config directory is not an orphan', () => {
  // `_config/` is what the installer writes *about* the install — the manifest
  // and the update-check stamp — rather than anything it copied. It is
  // legitimately unplanned, and on a clean checkout it is the only thing under
  // `_dev-workflow/` that is.
  const root = fixture();
  put(root, '_dev-workflow/_config/manifest.json', '{}\n');
  put(root, '_dev-workflow/_config/updatecheck.json', '{}\n');
  put(root, '_dev-workflow/artifacts/documentation/ledger.json', '{}\n');

  assert.deepEqual(checkPayload({ sourceRoot: root }).orphan, []);
});

test('AC6: a file belonging to another tool is not an orphan', () => {
  // A project is shared ground. `isOwnedPath` is the boundary the installer
  // writes and deletes through, and reporting outside it would be this check
  // claiming ground the installer itself refuses to touch.
  const root = fixture();
  put(root, '.claude/skills/other-tool/SKILL.md', '# not ours\n');
  put(root, '.claude/settings.json', '{}\n');

  assert.deepEqual(checkPayload({ sourceRoot: root }).orphan, []);
});
