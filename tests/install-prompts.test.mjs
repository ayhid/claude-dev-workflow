/**
 * The wizard's blank answers, guarded at the source.
 *
 * `@clack/prompts` renders a submitted text prompt as `value || placeholder`.
 * The empty string is falsy, so a prompt that *invites* a blank answer
 * (`defaultValue: ''`) and carries no placeholder prints the literal string
 * "undefined" back at the user — the bug in #18, which shipped visible in the
 * README's own demo recording.
 *
 * There is no way to assert this behaviourally without a TTY, so this is a
 * source-scanning guard in the style of tests/updatecheck.test.mjs and
 * tests/commitlint.test.mjs: the next prompt added to the wizard fails here
 * rather than in a recording.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'bin/install.mjs'), 'utf8');

/**
 * The argument object of every `p.text({ … })` call in `source`.
 *
 * Brace counting rather than a regex: the options contain nested braces of
 * their own (template literals, `c.dim(...)`), and a non-greedy match stops at
 * the first one of those.
 */
function textPromptOptions(source) {
  const out = [];
  const CALL = 'p.text({';
  let from = 0;

  for (;;) {
    const start = source.indexOf(CALL, from);
    if (start === -1) return out;

    let i = start + CALL.length - 1;
    let depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    out.push(source.slice(start + CALL.length - 1, i + 1));
    from = i + 1;
  }
}

const prompts = textPromptOptions(SOURCE);

test('the scan finds the wizard text prompts at all', () => {
  // A guard that silently matches nothing passes forever. If install.mjs is
  // restructured so `p.text({` no longer appears literally, this is the failure
  // that says so.
  assert.ok(prompts.length >= 3, `expected several p.text calls, found ${prompts.length}`);
});

test('every prompt that accepts a blank answer has a placeholder', () => {
  const offenders = prompts
    .filter((opts) => /defaultValue:\s*''/.test(opts))
    .filter((opts) => !/placeholder:/.test(opts))
    .map((opts) => (/message:\s*`([^`]{0,60})/.exec(opts)?.[1] ?? opts.slice(0, 60)).trim());

  assert.deepEqual(
    offenders,
    [],
    `these prompts would print "undefined" when left blank: ${offenders.join(' | ')}`,
  );
});

test('a placeholder is a non-empty string, since an empty one prints undefined too', () => {
  for (const opts of prompts) {
    const m = /placeholder:\s*'([^']*)'/.exec(opts);
    if (m) assert.notEqual(m[1], '', 'an empty placeholder defeats the point');
  }
});
