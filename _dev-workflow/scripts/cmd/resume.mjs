/**
 * Pick a ticket back up: put the working copy back, and say what was left there.
 *
 *   dev.mjs resume [ISSUE-ID] [--repo PATH] [--print]
 *
 * `status --all` already says a ticket is in flight with N dirty files. What it
 * cannot say is *which* files, or what was already committed — and after a
 * session ends, or a compaction, that is precisely the context that is gone.
 * This prints both, off the branch itself, so resuming does not start with a
 * guess about what the last session had been doing.
 *
 * It repairs two things and invents nothing:
 *
 *   - **A missing worktree.** The branch survives a worktree removed by hand,
 *     or one taken down on a machine this checkout was cloned from. Re-mounting
 *     it goes through `startWork`, the same path `start` uses, which reuses an
 *     existing branch — a branch that does not exist is `start`'s job, and this
 *     says so rather than creating one behind your back.
 *   - **A ticket behind its branch.** A branch exists, so the work is started;
 *     a ticket still sitting in the backlog is drift. It is moved to the start
 *     rung, forward only, exactly the rule `sync` applies — a ticket already at
 *     review or done, or parked off the ladder, is left alone and reported.
 *
 * `--print` reports and repairs nothing, which is what makes it safe to run
 * against someone else's branch.
 */
import { issueIdFromBranch, worktreePathFor } from '../../lib/branch.mjs';
import { rankOf } from '../../lib/config.mjs';
import { sh } from '../../lib/sh.mjs';
import { UNKNOWN } from '../../lib/sync.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, locateWork, preview, resolveRepo, UserError } from './common.mjs';

const USAGE = 'usage: dev.mjs resume [ISSUE-ID] [--repo PATH] [--print]';

function parseArgs(args) {
  const opts = { print: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--print' || a === '--dry-run') opts.print = true;
    else if (a === '--repo') opts.repo = args[++i];
    else if (a.startsWith('-')) throw new UserError(`unknown flag ${a}\n\n${USAGE}`);
    else rest.push(a);
  }
  return { opts, rest };
}

/**
 * Whether the ticket is behind the branch, and why not when it is not.
 *
 * Split out because it is the one judgement in this command, and the three
 * "leave it alone" cases — unreadable, off the ladder, already ahead — are each
 * a different thing to tell the user.
 *
 * @returns {{move: boolean, why: string}}
 */
export function stateGap(config, current) {
  if (!current || current === UNKNOWN) return { move: false, why: 'could not read the ticket state' };

  const start = config?.states?.start ?? null;
  if (!start) return { move: false, why: 'no states.start configured' };

  const here = rankOf(config, current);
  if (here < 0) return { move: false, why: `${current} is off the ladder — left alone` };
  if (here >= rankOf(config, start)) return { move: false, why: `already at ${current}` };

  return { move: true, why: `behind the branch at ${current}` };
}

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  const { config, root, provider } = await context();

  const configured = resolveRepo(config, root, opts.repo);
  const vcs = makeVcs({ run: sh });
  const repoDir = await vcs.mainCheckout(configured.dir);
  const base = config.branch?.base ?? 'main';

  // With no ID, the branch under the cursor is the question being asked — the
  // same inference `land` makes, and for the same reason: resuming the thing you
  // are standing in should not require typing its number.
  const here = (await vcs.currentBranch(process.cwd())) ?? (await vcs.currentBranch(repoDir));
  const id = rest[0] ?? (here ? issueIdFromBranch(config, here) : null);
  if (!id) {
    throw new UserError(
      `no issue ID given, and "${here ?? 'a detached HEAD'}" carries none.\n\n${USAGE}`,
    );
  }

  const issue = await provider.getIssue(id);
  if (!issue.ok) throw new UserError(issue.error);

  const found = await locateWork({ config, vcs, repoDir, id });
  if (!found) {
    throw new UserError(
      `no branch in ${repoDir} carries ${id} — this ticket has not been started here.\n` +
        `Start it: dev.mjs start ${id}`,
    );
  }

  const mode = config.branch?.mode ?? 'worktree';
  const L = [];
  L.push(`issue:    ${id} — ${issue.data.title}`);
  L.push(`repo:     ${configured.path} (${repoDir})`);
  L.push(`branch:   ${found.branch}`);

  // Re-mount before reading the tree: with no worktree there is nothing to read,
  // and reporting "clean" for a checkout that does not exist would be a lie of
  // exactly the kind this command is meant to end.
  let workDir = found.path;
  if (!workDir) {
    if (opts.print) {
      L.push(`mount:    missing — ${mode} mode would put it back (--print: nothing was created)`);
    } else {
      const started = await vcs.startWork({
        dir: repoDir,
        branch: found.branch,
        base,
        mode,
        worktreePath: worktreePathFor(config, { repoDir, branch: found.branch }),
      });
      if (!started.ok) throw new UserError(started.error);
      workDir = started.dir;
      L.push(`mount:    ${mode} put back at ${started.dir}`);
    }
  }

  const ahead = await vcs.commitsAhead(repoDir, { base, branch: found.branch });
  if (!ahead.ok) {
    L.push(`commits:  could not compare with ${base}: ${ahead.error}`);
  } else if (ahead.count === 0) {
    L.push(`commits:  none yet on ${found.branch}`);
  } else {
    L.push(`commits:  ${ahead.count} not on ${base}`);
    for (const c of preview(ahead.subjects, 5)) L.push(`          ${c}`);
  }

  if (workDir) {
    const clean = await vcs.isClean(workDir);
    if (!clean.ok) throw new UserError(clean.error);
    if (clean.clean) {
      L.push('changes:  none — the tree is clean');
    } else {
      L.push(`changes:  ${clean.dirty.length} uncommitted in ${workDir}`);
      for (const d of preview(clean.dirty, 20)) L.push(`          ${d}`);
    }
  }

  const gap = stateGap(config, issue.data.state);
  if (!gap.move) {
    L.push(`state:    ${issue.data.state} — ${gap.why}`);
  } else if (opts.print) {
    L.push(`state:    ${issue.data.state} — ${gap.why} (--print: not moved)`);
  } else {
    const moved = await provider.setState(id, 'start');
    L.push(moved.ok ? `state:    ${moved.state}` : `state:    NOT MOVED — ${moved.error}`);
    if (!moved.ok) {
      process.stdout.write(`${L.join('\n')}\n`);
      return 1;
    }
  }

  L.push(`next:     dev.mjs fetch ${id}   — re-read the ticket and its acceptance criteria`);
  if (workDir) L.push('', `cd ${workDir}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}
