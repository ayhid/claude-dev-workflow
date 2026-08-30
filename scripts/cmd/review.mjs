/**
 * Build the payloads an adversarial review runs on.
 *
 *   dev.mjs review                 this branch against the branch it lands on
 *   dev.mjs review --base main     against an explicit ref
 *   dev.mjs review --out DIR       write the payloads there (default: a temp dir)
 *   dev.mjs review --no-intent     skip the tracker read
 *
 * This command exists for the reason CLAUDE.md gives for every other one: the
 * three payloads are eight or nine tool calls of git and tracker work that
 * produce the same bytes every time, and a session that derives them by hand
 * pays a whole context read per turn to do it. Deriving them here costs one.
 *
 * It writes files rather than printing the diff. A diff printed to stdout lands
 * in the session's context and is then paid for on every subsequent turn — the
 * blind lens in particular must be read by a *fresh* agent, so putting it in
 * this session's context is both expensive and self-defeating.
 *
 * The three payloads differ in what they contain, and that is the whole design:
 *
 *   change.diff   the patch. Every lens gets this.
 *   context.txt   full source of the changed files. Edge and audit lenses.
 *   intent.md     the ticket. Audit lens only, and never the blind one.
 *
 * Reports and never writes to the tracker.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { deliveryBase, deliveryFor } from '../../lib/config.mjs';
import { issueIdFromBranch } from '../../lib/branch.mjs';
import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, UserError } from './common.mjs';

/** Past this, a model's review quality collapses and it starts inventing findings. */
export const LINE_CEILING = 800;

/** Source is only worth attaching for files a reviewer would actually read. */
const MAX_CONTEXT_BYTES = 200_000;

function parseArgs(args) {
  const opts = { base: '', out: '', intent: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base') opts.base = args[++i] ?? '';
    else if (a === '--out') opts.out = args[++i] ?? '';
    else if (a === '--no-intent') opts.intent = false;
    else throw new UserError(
      `unknown argument '${a}' — usage: dev.mjs review [--base REF] [--out DIR] [--no-intent]`,
    );
  }
  return opts;
}

/**
 * Concatenate the current source of each changed file.
 *
 * Deleted files are skipped rather than reported: there is no source to read,
 * and the patch already shows what left. The cap is a byte budget across the
 * whole payload, so one enormous file cannot crowd out the other twenty.
 */
export function buildContext(files, { root, readFile = readFileSync, sizeOf = statSync } = {}) {
  const parts = [];
  const skipped = [];
  let budget = MAX_CONTEXT_BYTES;

  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;

    let size = 0;
    try {
      size = sizeOf(abs).size;
    } catch {
      continue;
    }
    if (size > budget) {
      skipped.push(rel);
      continue;
    }
    budget -= size;
    parts.push(`=== ${rel} ===\n${readFile(abs, 'utf8')}\n`);
  }

  if (skipped.length) {
    parts.push(`=== omitted, payload budget exhausted ===\n${skipped.join('\n')}\n`);
  }
  return parts.join('');
}

/** The ticket, rendered flat. Absent intent is a finding, not an error — say so plainly. */
async function buildIntent({ provider, config, branch }) {
  const id = issueIdFromBranch(config, branch);
  if (!id) {
    return `No issue ID in the branch name "${branch}", so no stated intent was available.`;
  }

  const r = await provider.getIssue(id);
  if (!r.ok) {
    return `Issue ${id} could not be read: ${r.error}\nNo stated intent was available.`;
  }

  const issue = r.data;
  const lines = [
    `Issue: ${issue.id} — ${issue.title || '(no title)'}`,
    `State: ${issue.state}`,
    '',
    issue.body?.trim() ? issue.body : '(no description)',
  ];
  if (issue.comments?.length) {
    lines.push('', `Comments (${issue.comments.length}):`, '');
    for (const c of issue.comments) lines.push(`@${c.author}: ${c.body}`, '');
  }
  return lines.join('\n');
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const { config, root, provider } = await context();
  const vcs = makeVcs({ run: sh });

  // `root` is the checkout the config was found in, which in worktree mode is
  // the worktree rather than the repo root. That is the one we want: reviewing
  // from the repo root would diff the base branch against itself and report a
  // clean tree, which reads as "nothing was done" (CLAUDE.md, git rule 4).
  const branch = await vcs.currentBranch(root);
  if (!branch) throw new UserError(`detached HEAD in ${root} — check out a branch to review it`);

  const base = opts.base || deliveryBase(config, deliveryFor(config, root));
  if (branch === base) {
    throw new UserError(
      `on ${branch}, which is the base branch — there is nothing to review against. ` +
        'Check out the work, or pass --base.',
    );
  }

  const d = await vcs.diffRange(root, { base });
  if (!d.ok) throw new UserError(d.error);

  const out = opts.out
    ? resolve(opts.out)
    : mkdtempSync(join(tmpdir(), 'dev-review-'));
  mkdirSync(out, { recursive: true });

  writeFileSync(join(out, 'change.diff'), d.patch);
  writeFileSync(join(out, 'context.txt'), d.files.length ? buildContext(d.files, { root }) : '');
  writeFileSync(
    join(out, 'intent.md'),
    opts.intent ? await buildIntent({ provider, config, branch }) : 'Intent was withheld deliberately.',
  );

  const report = [
    `branch:   ${branch}`,
    `base:     ${base}`,
    `files:    ${d.files.length}`,
    `lines:    ${d.lines}`,
    '',
    'payloads:',
    `  ${join(out, 'change.diff')}`,
    `  ${join(out, 'context.txt')}`,
    `  ${join(out, 'intent.md')}`,
  ];

  if (d.lines === 0) {
    report.push('', 'Nothing reviewable changed. Stop here rather than reviewing an empty diff.');
  } else if (d.lines > LINE_CEILING) {
    report.push(
      '',
      `${d.lines} lines is past the ${LINE_CEILING}-line ceiling. Review quality collapses`,
      'past it and the findings start being invented. Say so and offer to split the branch',
      'rather than reviewing it anyway.',
    );
  }

  process.stdout.write(`${report.join('\n')}\n`);
  return 0;
}
