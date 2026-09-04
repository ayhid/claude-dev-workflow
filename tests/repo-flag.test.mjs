/**
 * `--repo` is parsed at ten call sites, one per command, because nothing
 * routes them through a shared parser. This walks every one of them so an
 * eleventh command cannot reintroduce the hole #66 found: a valueless
 * `--repo` silently ran against the default repo, and `--repo --apply` ate
 * `--apply` as the repo path, turning `land --apply` into a silent dry run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs as parseAbandonArgs } from '../scripts/cmd/abandon.mjs';
import { parseArgs as parseAssessArgs } from '../scripts/cmd/assess.mjs';
import { parseScanArgs as parseIngestArgs } from '../scripts/cmd/ingest.mjs';
import { parseArgs as parseLandArgs } from '../scripts/cmd/land.mjs';
import { parseRewriteArgs } from '../scripts/cmd/reorg.mjs';
import { parseArgs as parseResumeArgs } from '../scripts/cmd/resume.mjs';
import { parseArgs as parseRulesArgs } from '../scripts/cmd/rules.mjs';
import { parseArgs as parseStandupArgs } from '../scripts/cmd/standup.mjs';
import { parseArgs as parseStartArgs } from '../scripts/cmd/start.mjs';
import { parseArgs as parseStatusArgs } from '../scripts/cmd/status.mjs';
import { parseArgs as parseSyncArgs } from '../scripts/cmd/sync.mjs';

// { name, parse } — parse throws on a bad --repo, or returns/rejects for ingest's async scan.
const COMMANDS = [
  { name: 'assess', parse: (argv) => parseAssessArgs(argv) },
  { name: 'rules', parse: (argv) => parseRulesArgs(argv) },
  { name: 'standup', parse: (argv) => parseStandupArgs(argv) },
  { name: 'status', parse: (argv) => parseStatusArgs(argv) },
  { name: 'abandon', parse: (argv) => parseAbandonArgs(argv) },
  { name: 'land', parse: (argv) => parseLandArgs(argv) },
  { name: 'resume', parse: (argv) => parseResumeArgs(argv) },
  { name: 'start', parse: (argv) => parseStartArgs(argv) },
  { name: 'sync', parse: (argv) => parseSyncArgs(argv) },
  { name: 'ingest scan', parse: (argv) => parseIngestArgs(argv) },
  // Not one of the ten the ticket enumerated — found by this same test walk,
  // the exact "eleventh command" scenario AC4 exists to catch.
  { name: 'reorg rewrite', parse: (argv) => parseRewriteArgs(argv) },
];

for (const { name, parse } of COMMANDS) {
  test(`${name}: --repo with no value is refused, naming the flag`, () => {
    assert.throws(() => parse(['--repo']), /--repo/, name);
  });

  test(`${name}: --repo followed by another flag is refused rather than eating it`, () => {
    assert.throws(() => parse(['--repo', '--force']), /--repo/, name);
  });
}

test('land: --repo --apply is refused rather than silently becoming a dry run', () => {
  // The exact failure from #66: --apply consumed as the repo path, so the
  // flag that makes the write real disappears and the run looks like a
  // successful dry run instead of an error.
  assert.throws(() => parseLandArgs(['--repo', '--apply']), /--repo/);
});

