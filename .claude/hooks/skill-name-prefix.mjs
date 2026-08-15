#!/usr/bin/env node
// PostToolUse(Edit|Write) guard: a shipped SKILL.md must declare `name:` equal
// to its directory, and that name must be namespaced `yt-`.
//
// Repo-local development tooling — this lives under .claude/ and is NOT part of
// the shipped payload. It exists because 1.1.0 shipped skills named `task`,
// `bug` and `done`: the exact generic names CLAUDE.md forbids, past a CI check
// that only compared name against directory.
//
// Exit 0 = fine. Exit 2 = surface stderr back to Claude for correction (the
// write has already happened; this is a correction prompt, not a block).
// No network, no dependencies, no shell.
import { readFileSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { readHookInput, allow, block, run } from './lib.mjs';

const PREFIX = 'yt-';

run('skill-name-prefix', () => {
  const input = readHookInput();
  if (!input) {
    process.stderr.write('skill-name-prefix: unreadable hook payload; not enforcing.\n');
    allow();
  }

  const file = input.tool_input?.file_path ?? '';
  if (!file) allow();

  // Fast bail: only the shipped skills carry this rule. Repo-local skills under
  // .claude/skills/ are not distributed and may be named anything.
  if (!file.endsWith(`${sep}SKILL.md`)) allow();
  if (!file.includes(`${sep}skills${sep}`)) allow();
  // Narrowly `.claude/skills/`, not any path containing `.claude` — the plugin
  // cache lives under `~/.claude/plugins/` and must still be checked.
  if (file.includes(`${sep}.claude${sep}skills${sep}`)) allow();

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    allow(); // file gone or unreadable: defer rather than guess
  }

  const dir = basename(dirname(file));
  const declared = text.match(/^name:[ \t]*(\S+)[ \t]*$/m)?.[1];

  // No frontmatter name at all is a different failure; CI already catches it.
  if (!declared) allow();

  const problems = [];
  if (declared !== dir) problems.push(`  - name '${declared}' does not match directory '${dir}'`);
  if (!dir.startsWith(PREFIX)) problems.push(`  - directory '${dir}' is not namespaced '${PREFIX}'`);
  if (!declared.startsWith(PREFIX)) problems.push(`  - name '${declared}' is not namespaced '${PREFIX}'`);

  if (!problems.length) allow();

  block(
    [
      'BLOCKED: a shipped skill is misnamed.',
      `  file:      ${file}`,
      ...problems,
      '  Skills live in a flat namespace next to every other skill the user has',
      "  installed. 'task', 'bug' and 'done' are far too generic to claim.",
    ].join('\n'),
  );
});
