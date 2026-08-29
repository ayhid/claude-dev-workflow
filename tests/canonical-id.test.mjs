/**
 * One spelling of an issue ID, whichever spelling was typed (#43).
 *
 * The GitHub adapter accepts `#12`, `12` and `acme/api#12` alike — deliberately,
 * and that stays — so every command worked and only the *record* was wrong: a
 * `dev.mjs start 37` logged `"id":"37"` while every close of the same ticket
 * logged `"id":"#37"`, and nothing downstream could tell they were one ticket.
 *
 * So the assertions here are about what a command *says* and what it *writes*,
 * not about whether it succeeds. All six drive the real CLI against the shared
 * `gh` stub, because the claim is that argv is normalised before the tracker
 * call, the branch name, the printed line and the metrics log ever see it — and
 * only the whole command exercises all four.
 *
 * This file is also the guard against the seventh command. Canonicalising once
 * per command is six call sites, which is the shape `CLAUDE.md` warns about; the
 * alternative — normalising inside the provider or the metrics wrapper — is one
 * site that fixes the log and leaves the printed `issue:` line disagreeing with
 * it. The table below is what a seventh command has to be added to.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withStubGh } from './ghstub.mjs';

/** Every id the metrics log holds, in order. */
function loggedIds(root) {
  const path = join(root, '.dev-workflow.metrics.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).id);
}

test('start: a bare number reaches the branch check, the output and the log as #12', async () => {
  const s = await withStubGh();
  const r = await s.dev(['start', '12']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^issue:\s+#12 —/m);
  // The round-trip check at start.mjs compares the branch's id with the one it
  // was given, and `12` !== `#12` — so the warning fired on every bare id and
  // said nothing was wrong that was wrong.
  assert.doesNotMatch(r.stdout, /warning:/, r.stdout);
  assert.deepEqual(loggedIds(s.projectRoot), ['#12']);
});

test('update: a close typed bare joins the start typed bare', async () => {
  // The whole point of the ticket. `currentCycle` joins on exact string
  // equality, so a start logged as `12` and a close logged as `#12` are two
  // tickets: elapsedMs comes out null and starts 0 for a cycle that has both.
  // (Only start, abandon and done are recorded — `roleOf` has no opinion about
  // the review rung — so the close is what this has to be asserted against.)
  const s = await withStubGh();
  assert.equal((await s.dev(['start', '12'])).code, 0);
  const r = await s.dev(['update', '12', 'state', 'done']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^dev update: #12 —/m);
  assert.deepEqual(loggedIds(s.projectRoot), ['#12', '#12']);

  const close = JSON.parse(readFileSync(join(s.projectRoot, '.dev-workflow.metrics.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .at(-1));
  assert.equal(close.event, 'done');
  assert.equal(close.starts, 1, 'the close must find the start');
  assert.ok(close.elapsedMs !== null, 'and therefore measure a cycle');
});

test('abandon: the walk-back is recorded under the same id as the start', async () => {
  const s = await withStubGh();
  const r = await s.dev(['abandon', '12', 'superseded', '--force']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^issue:\s+#12 —/m);
  assert.deepEqual(loggedIds(s.projectRoot), ['#12']);
});

test('resume: the id it reports is the id the branch reads back as', async () => {
  const s = await withStubGh();
  const r = await s.dev(['resume', '12', '--print']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^issue:\s+#12 —/m);
});

test('land: even a refusal names the ticket the one way', async () => {
  // Run from the repo root, which in worktree mode is the base branch — the
  // refusal that says where the work actually is.
  const s = await withStubGh();
  const r = await s.dev(['land', '12']);

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /#12 is checked out in/);
});

// This one passes with or without the change, and is kept for saying so: the
// adapter already normalises what `fetch` prints, so canonicalising its argv
// alters nothing observable. It is here to pin that `o/r#12` resolves at all,
// and the §7 evidence for `fetch` is the code, not this test.
test('fetch: an id with an owner/repo prefix is the same issue', async () => {
  const s = await withStubGh();
  const r = await s.dev(['fetch', 'o/r#12']);

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^# #12 —/m);
});
