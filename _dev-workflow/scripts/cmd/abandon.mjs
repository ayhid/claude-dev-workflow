/**
 * Give up on a ticket: say why, put it back, and take the working copy down.
 *
 *   dev.mjs abandon <ISSUE-ID> <REASON|@FILE> [--force] [--repo PATH]
 *
 * The four things this does are the four nobody does in the right order by
 * hand — comment the reason, walk the ticket back, remove the worktree, delete
 * the branch — and the one that matters most is the first. A ticket abandoned
 * silently is indistinguishable from a ticket forgotten, so the reason is a
 * required argument rather than a flag: an optional one gets skipped exactly
 * when the trail would have been worth having.
 *
 * Where the ticket goes is `states.abandon`, and there is deliberately no
 * fallback for it (lib/config.mjs). `sync` only ever moves forward, so nothing
 * else in this tool can walk a ticket back, and nothing else will undo a wrong
 * guess here either.
 *
 * ## Why it writes immediately, and what protects the work instead
 *
 * `land` and `sync` are dry runs until `--apply`, because what they would do is
 * hard to picture. This is the opposite: it is one ticket and one branch, and a
 * dry run would mostly be ceremony. The protection is `--force` — a tree with
 * uncommitted changes, or a branch carrying commits the base has not seen, is
 * refused outright, and the refusal lists exactly what would be lost. Nothing
 * is written before that check, so a refusal really does leave everything as it
 * was found.
 *
 * It does not look at pull requests and never closes one. An open PR that
 * references the ticket will pull it back to the review rung the next time the
 * reconciler runs — close the PR too, or the walk-back does not stick.
 */
import { resolve } from 'node:path';

import { resolveRung } from '../../lib/config.mjs';
import { canonicalId } from '../../lib/issueid.mjs';
import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import {
  context,
  locateWork,
  preview,
  readArg,
  resolveRepo,
  takeValue,
  UserError,
} from './common.mjs';

const USAGE =
  'usage: dev.mjs abandon <ISSUE-ID> <REASON|@FILE> [--force] [--repo PATH]';

export function parseArgs(args) {
  const opts = { force: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') opts.force = true;
    else if (a === '--repo') opts.repo = takeValue(args, ++i, a);
    else if (a.startsWith('-')) throw new UserError(`unknown flag ${a}\n\n${USAGE}`);
    else rest.push(a);
  }
  return { opts, rest };
}

/** The comment left on the ticket: the reason, then the inventory of what went. */
export function abandonComment({ reason, branch, commits = 0, changes = 0 }) {
  const L = [`Abandoned — ${String(reason).trim()}`, ''];

  if (!branch) {
    L.push('No local branch was found for this ticket, so nothing was deleted.');
    return L.join('\n');
  }

  const lost = [
    commits ? `${commits} commit${commits === 1 ? '' : 's'} not on the base branch` : null,
    changes ? `${changes} uncommitted change${changes === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  L.push(`Dropped \`${branch}\`${lost.length ? `, discarding ${lost.join(' and ')}` : ''}.`);
  return L.join('\n');
}

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  const [rawId, rawReason] = rest;
  if (!rawId) throw new UserError(USAGE);
  if (rawReason === undefined) {
    throw new UserError(
      `abandoning ${rawId} needs a reason — it is the only record of why the work stopped.\n\n${USAGE}`,
    );
  }
  const reason = readArg(rawReason, 'reason file').trim();
  if (!reason) throw new UserError('the reason is empty');

  const { config, root, provider } = await context();
  // One spelling from here on — see canonicalId in lib/issueid.mjs (#43).
  const id = canonicalId(config, rawId);

  // Fail on the missing key before anything is read or written. A project that
  // has never configured this rung finds out here, with the key named, rather
  // than after the branch has already gone.
  const target = resolveRung(config, 'abandon');
  if (!target.ok) {
    throw new UserError(
      `${target.error} — the state a ticket goes back to when its work is thrown away, e.g. "Backlog"`,
    );
  }

  const configured = resolveRepo(config, root, opts.repo);
  const vcs = makeVcs({ run: sh });
  const repoDir = await vcs.mainCheckout(configured.dir);
  const base = config.branch?.base ?? 'main';

  // Read the issue first: an ID that does not resolve is a typo, and finding
  // that out after the worktree is gone helps nobody.
  const issue = await provider.getIssue(id);
  if (!issue.ok) throw new UserError(issue.error);

  const found = await locateWork({ config, vcs, repoDir, id });
  if (found?.branch === base) {
    throw new UserError(
      `${id} resolves to "${base}", which is the base branch — refusing to delete it`,
    );
  }

  // Where the ticket's files are: its worktree, or the main checkout when the
  // branch is what that has checked out. Neither, for a branch nobody has
  // mounted — there is nothing to lose there but the commits.
  const workDir =
    found?.path ?? ((await vcs.currentBranch(repoDir)) === found?.branch ? repoDir : null);

  const cwd = process.cwd();
  if (found?.path && (cwd === resolve(found.path) || cwd.startsWith(`${resolve(found.path)}/`))) {
    throw new UserError(
      `you are inside ${found.path}, which is the worktree this would remove.\n` +
        `cd ${repoDir} and run it again.`,
    );
  }

  // Everything that would be destroyed, gathered before a single write.
  const clean = workDir ? await vcs.isClean(workDir) : { ok: true, clean: true, dirty: [] };
  if (!clean.ok) throw new UserError(clean.error);
  const ahead = found ? await vcs.commitsAhead(repoDir, { base, branch: found.branch }) : null;

  const blockers = [];
  const discarding = [];
  if (!clean.clean) {
    discarding.push(`${clean.dirty.length} uncommitted change${clean.dirty.length === 1 ? '' : 's'}`);
    blockers.push(
      `${discarding[discarding.length - 1]} in ${workDir}:`,
      ...preview(clean.dirty.map((d) => `  ${d}`)),
    );
  }
  if (ahead?.ok && ahead.count > 0) {
    discarding.push(`${ahead.count} commit${ahead.count === 1 ? '' : 's'} not on ${base}`);
    blockers.push(
      `${discarding[discarding.length - 1]}, on ${found.branch}:`,
      ...preview(ahead.subjects.map((c) => `  ${c}`), 5),
    );
  }
  if (blockers.length && !opts.force) {
    throw new UserError(
      `${id} still holds work, and nothing has been changed:\n${blockers.join('\n')}\n` +
        'Land it (dev.mjs land) or keep it, or pass --force to discard exactly the above.',
    );
  }

  const L = [];
  L.push(`issue:    ${id} — ${issue.data.title}`);
  L.push(`repo:     ${configured.path} (${repoDir})`);
  L.push(found ? `branch:   ${found.branch}${found.path ? `   (${found.path})` : ''}` : 'branch:   none found');
  if (discarding.length) L.push(`discard:  ${discarding.join(', ')}`);
  if (ahead && !ahead.ok) L.push(`warning:  could not compare with ${base}: ${ahead.error}`);

  // The tracker first, the destruction second. A tracker that refuses the write
  // costs a retry; a branch deleted before the reason was recorded costs the
  // reason. This order is the only one where a failure is free.
  const comment = abandonComment({
    reason,
    branch: found?.branch ?? null,
    commits: ahead?.ok ? ahead.count : 0,
    changes: clean.dirty.length,
  });
  const moved = await provider.setState(id, 'abandon', comment);
  if (!moved.ok) {
    throw new UserError(`${moved.error}\nNothing was deleted — the working copy is untouched.`);
  }
  L.push(`state:    ${moved.state}`);
  // Rule 3: the state that came back is the state, and when the backend cannot
  // represent the one that was asked for, saying so is the whole point of
  // reading it back at all.
  if (moved.state !== target.state) {
    L.push(`warning:  asked for "${target.state}" but the tracker reports "${moved.state}"`);
  }

  let code = moved.state === target.state ? 0 : 1;

  if (found) {
    const cleaned = await vcs.cleanupWork({
      repoDir,
      worktreePath: found.path,
      branch: found.branch,
      worktreeRoot: `${repoDir}/${config.branch?.worktreeDir ?? '.worktrees'}`,
      force: opts.force,
      switchTo: base,
    });
    if (!cleaned.ok) {
      process.stdout.write(`${L.join('\n')}\n`);
      throw new UserError(`${cleaned.error}\nThe ticket has already been moved to ${moved.state}.`);
    }
    for (const n of cleaned.notes) L.push(`          ${n}`);
    if (!cleaned.branchDeleted) code = 1;
  }

  if (found?.path) L.push('', `cd ${repoDir}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return code;
}
