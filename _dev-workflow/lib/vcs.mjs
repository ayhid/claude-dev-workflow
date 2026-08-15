/**
 * The git operations the workflow performs, with the runner injected.
 *
 * Same shape as the provider adapters and for the same reason (lib/provider.mjs
 * rule 1): a caller hands in `sh`, a test hands in a fake, and every branch of
 * this file is exercisable without touching a repository. `lib/branch.mjs`
 * decides what things are called; this decides what happens.
 *
 * Two rules are enforced here rather than documented:
 *
 *   - **No hook bypass.** `--no-verify`, `HUSKY=0` and friends never leave this
 *     module, because a commit hook is the thing keeping issue references on
 *     commits in the first place.
 *   - **No forced conflict resolution.** `-X theirs` / `--strategy=ours` and
 *     `checkout --theirs` silently discard one side of a conflict. A conflict is
 *     reported and the tree is put back the way it was found.
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Arguments that would defeat a guarantee this module makes. */
// `-n` is deliberately absent: it means `--dry-run` to `git push`, and blocking
// a dry run in the name of not skipping hooks would be exactly backwards.
const FORBIDDEN = [
  '--no-verify',
  '--strategy-option=theirs',
  '--strategy-option=ours',
  '-Xtheirs',
  '-Xours',
  '--theirs',
  '--ours',
];

/**
 * A git invocation is refused outright if it carries one of these. The check is
 * here, at the single choke point, so it holds for code added later too — a
 * reviewer should not have to notice a `--no-verify` in a new call site.
 */
function assertAllowed(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FORBIDDEN.includes(a) || (a === '-X' && ['theirs', 'ours'].includes(args[i + 1]))) {
      throw new Error(
        `refusing to run git with ${a}: this workflow never bypasses hooks or force-resolves conflicts`,
      );
    }
  }
}

/**
 * @param {{run: Function}} io  `run` is lib/sh.mjs's `sh`
 */
export function makeVcs({ run }) {
  if (typeof run !== 'function') throw new Error('makeVcs needs a `run` function');

  /** Every git call goes through here. Argv array, never a shell string. */
  const git = (dir, args, opts = {}) => {
    assertAllowed(args);
    return run('git', ['-C', dir, ...args], opts);
  };

  /** The branch checked out in `dir`, or null in a detached HEAD. */
  async function currentBranch(dir) {
    const r = await git(dir, ['branch', '--show-current']);
    return r.ok && r.stdout ? r.stdout : null;
  }

  async function branchExists(dir, branch) {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return r.ok && Boolean(r.stdout);
  }

  async function refExists(dir, ref) {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', ref]);
    return r.ok && Boolean(r.stdout);
  }

  /**
   * Is the tree free of changes that would be disturbed by switching branches?
   *
   * The workflow's own config is excluded: `/dev-init` and the installer rewrite
   * `.dev-workflow.json`, and having that edit block the very command it was
   * made to configure is a loop with no exit.
   *
   * `paths` narrows the question. The default asks about the whole tree, which is
   * what switching a branch cares about; an upgrade cares only about the
   * directories it is going to rewrite, and blocking it on an unrelated edit
   * elsewhere in the repo would be the same no-exit loop.
   */
  async function isClean(dir, { exclude = ['.dev-workflow.json'], paths = ['.'] } = {}) {
    const args = ['status', '--porcelain', '--', ...paths, ...exclude.map((p) => `:(exclude)${p}`)];
    const r = await git(dir, args);
    if (!r.ok) return { ok: false, error: r.stderr || `git status failed in ${dir}` };
    return { ok: true, clean: r.stdout === '', dirty: r.stdout ? r.stdout.split('\n') : [] };
  }

  /** Paths of every worktree registered on this repo, main checkout included. */
  async function listWorktrees(dir) {
    const r = await git(dir, ['worktree', 'list', '--porcelain']);
    if (!r.ok) return [];
    return r.stdout
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim());
  }

  /**
   * The **main** checkout of the repository `dir` belongs to.
   *
   * `git worktree list` always names it first. This matters more than it looks:
   * the config file is tracked, so a worktree carries its own copy, and
   * `loadConfig`'s upward walk resolves the project root to the *worktree* when
   * a command is run from inside one. Merging into the base there fails with
   * "'main' is already used by worktree at …", because it is — over here.
   */
  async function mainCheckout(dir) {
    const [first] = await listWorktrees(dir);
    return first ?? dir;
  }

  /** Would git ignore `relPath` in `dir`? Used to warn about `.worktrees/`. */
  async function isIgnored(dir, relPath) {
    const r = await git(dir, ['check-ignore', '-q', '--', relPath]);
    // check-ignore exits 0 when ignored, 1 when not, >1 on error.
    return r.code === 0;
  }

  /**
   * Put the working copy for `branch` in place, and report where it landed.
   *
   * Returns the directory to run everything else in — the point of worktree mode
   * is that this is *not* the repo root, and a caller that assumes otherwise
   * silently edits the wrong checkout.
   *
   * @returns {Promise<{ok: true, mode: string, branch: string, dir: string, created: boolean}
   *                 | {ok: false, error: string}>}
   */
  async function startWork({ dir, branch, base, mode = 'worktree', worktreePath }) {
    const existed = await branchExists(dir, branch);

    if (!(await refExists(dir, base)) && !existed) {
      return { ok: false, error: `base branch "${base}" does not exist in ${dir}` };
    }

    if (mode === 'branch') {
      const clean = await isClean(dir);
      if (!clean.ok) return clean;
      if (!clean.clean) {
        return {
          ok: false,
          error:
            `${dir} has uncommitted changes; switching branches would carry them onto the ticket.\n` +
            `  ${clean.dirty.join('\n  ')}\n` +
            'Commit or stash them, or use worktree mode, which leaves this checkout alone.',
        };
      }

      const r = existed
        ? await git(dir, ['switch', branch])
        : await git(dir, ['switch', '-c', branch, base]);
      if (!r.ok) return { ok: false, error: r.stderr || `could not switch to ${branch}` };

      // Read back: git can decline a switch and still exit 0 in edge cases, and
      // reporting the branch we asked for rather than the one we are on is
      // exactly the failure the provider contract's rule 3 exists to prevent.
      const now = await currentBranch(dir);
      if (now !== branch) {
        return { ok: false, error: `asked for ${branch}, but ${dir} is on ${now ?? 'a detached HEAD'}` };
      }
      return { ok: true, mode, branch, dir, created: !existed };
    }

    if (mode !== 'worktree') {
      return { ok: false, error: `unknown branch.mode "${mode}" — expected "worktree" or "branch"` };
    }

    // Already mounted somewhere? Re-use it rather than failing: a second
    // /dev-task on the same ticket should land you back in your work.
    const mounted = await listWorktrees(dir);
    const target = resolve(worktreePath);
    if (mounted.some((p) => resolve(p) === target)) {
      return { ok: true, mode, branch, dir: target, created: false };
    }

    const r = existed
      ? await git(dir, ['worktree', 'add', target, branch])
      : await git(dir, ['worktree', 'add', '-b', branch, target, base]);
    if (!r.ok) return { ok: false, error: r.stderr || `could not create a worktree at ${target}` };

    const now = await currentBranch(target);
    if (now !== branch) {
      return { ok: false, error: `worktree at ${target} is on ${now ?? 'a detached HEAD'}, not ${branch}` };
    }
    return { ok: true, mode, branch, dir: target, created: !existed };
  }

  /**
   * Land `branch` on `base` without a pull request: rebase, fast-forward, push.
   *
   * `repoDir` is the main checkout and `workDir` is where the branch is (the
   * same directory in branch mode, the worktree otherwise). The rebase runs
   * where the branch is checked out; the merge runs in the main checkout, which
   * is switched to `base` for it and — in worktree mode — switched back after.
   *
   * `base` is the delivery target, which is not necessarily the branch `repoDir`
   * has checked out: `delivery.base` lets a project fork from one branch and
   * land on another.
   *
   * A rebase conflict aborts and reports. Resolving it is a judgement call about
   * someone's code, which is not a thing this should make silently.
   */
  async function landDirect({ repoDir, workDir, branch, base, remote = 'origin', push = true }) {
    const steps = [];

    const clean = await isClean(workDir);
    if (!clean.ok) return clean;
    if (!clean.clean) {
      return {
        ok: false,
        error: `${workDir} has uncommitted changes — commit them before landing:\n  ${clean.dirty.join('\n  ')}`,
      };
    }

    // Rebase onto the freshest base we can see. With a remote, that is the
    // remote-tracking ref: landing onto a stale local base is how a "clean
    // fast-forward" turns into someone else's revert.
    let onto = base;
    const hasRemote = (await git(repoDir, ['remote', 'get-url', remote])).ok;
    if (hasRemote) {
      const f = await git(repoDir, ['fetch', remote, base]);
      steps.push(`fetch ${remote} ${base}: ${f.ok ? 'ok' : f.stderr}`);
      if (f.ok && (await refExists(repoDir, `${remote}/${base}`))) onto = `${remote}/${base}`;
    }

    const rebase = await git(workDir, ['rebase', onto]);
    if (!rebase.ok) {
      const abort = await git(workDir, ['rebase', '--abort']);
      return {
        ok: false,
        error:
          `rebasing ${branch} onto ${onto} hit a conflict; the branch is unchanged.\n` +
          `${rebase.stderr || rebase.stdout}\n` +
          (abort.ok ? '' : `and "git rebase --abort" also failed: ${abort.stderr}\n`) +
          'Resolve it on the branch, then run this again.',
      };
    }
    steps.push(`rebase onto ${onto}: ok`);

    // In branch mode the base has to be checked out before it can be merged
    // into; in worktree mode it already is, in the main checkout.
    const wasOn = await currentBranch(repoDir);
    if (wasOn !== base) {
      const sw = await git(repoDir, ['switch', base]);
      if (!sw.ok) return { ok: false, error: sw.stderr || `could not switch ${repoDir} to ${base}` };
      steps.push(`switch ${base}: ok`);
    }
    if (hasRemote && onto !== base) {
      const ff = await git(repoDir, ['merge', '--ff-only', onto]);
      if (!ff.ok) {
        return {
          ok: false,
          error:
            `local ${base} has commits that are not on ${onto}, so it cannot fast-forward.\n${ff.stderr}`,
        };
      }
    }

    const merge = await git(repoDir, ['merge', '--ff-only', branch]);
    if (!merge.ok) {
      return { ok: false, error: `${base} could not fast-forward to ${branch}:\n${merge.stderr}` };
    }
    steps.push(`merge --ff-only ${branch}: ok`);

    if (push) {
      if (!hasRemote) {
        steps.push(`push: skipped — no remote "${remote}"`);
      } else {
        const p = await git(repoDir, ['push', remote, base]);
        if (!p.ok) return { ok: false, error: `pushing ${base} to ${remote} failed:\n${p.stderr}` };
        steps.push(`push ${remote} ${base}: ok`);
      }
    }

    // Read back what actually landed rather than reporting the plan. This has to
    // happen before the restore below, or it reports the head of whatever branch
    // the checkout went back to instead of the one that was landed onto.
    const head = await git(repoDir, ['rev-parse', '--short', 'HEAD']);

    // Put the main checkout back where it was found. It only moved when the
    // target is not what was checked out there — which, before `delivery.base`
    // existed, could not happen: the target was always `branch.base` and the
    // main checkout always sat on it. Now a project can deliver onto `develop`
    // while the checkout is on `main`, and leaving it on `develop` afterwards is
    // the "a later command edits the wrong branch and reports a clean tree"
    // failure this module exists to prevent.
    //
    // Worktree mode only: in branch mode `wasOn` is the ticket branch, which the
    // caller is about to delete, so staying on the target is the correct resting
    // place there.
    if (wasOn && wasOn !== base && workDir !== repoDir) {
      const back = await git(repoDir, ['switch', wasOn]);
      steps.push(
        back.ok
          ? `switch ${repoDir} back to ${wasOn}: ok`
          : `warning: ${repoDir} is left on ${base}, not ${wasOn}: ${back.stderr}`,
      );
    }

    return { ok: true, steps, base, head: head.stdout, pushed: push && hasRemote };
  }

  /**
   * Take the worktree and branch down, in the three tiers that survive reality.
   *
   * A plain remove fails with ENOTEMPTY when a process the session left running
   * recreated something inside (a test runner's cache is the usual culprit) —
   * and by then git may already have dropped its admin entry, which makes the
   * `--force` retry fail with "is not a working tree". The last tier is git's
   * own documented reclaim path: delete the directory, then prune.
   */
  async function cleanupWork({ repoDir, worktreePath, branch, worktreeRoot }) {
    const notes = [];

    if (worktreePath) {
      const first = await git(repoDir, ['worktree', 'remove', worktreePath]);
      if (!first.ok) {
        const forced = await git(repoDir, ['worktree', 'remove', '--force', worktreePath]);
        if (!forced.ok) {
          // rm, unlike `git worktree remove`, validates nothing. Confine it to
          // the configured worktree root or refuse — a bad `worktreeDir` must
          // not become a recursive delete of somebody's home directory.
          const target = resolve(worktreePath);
          const root = resolve(worktreeRoot ?? worktreePath);
          if (!target.startsWith(`${root}/`) && target !== root) {
            return { ok: false, error: `refusing to delete ${target}: outside ${root}` };
          }
          await rm(target, { recursive: true, force: true });
          await git(repoDir, ['worktree', 'prune']);
          notes.push(`worktree removed by hand and pruned (${forced.stderr || first.stderr})`);
        } else {
          notes.push('worktree removed with --force');
        }
      }
    }

    if (branch) {
      const del = await git(repoDir, ['branch', '-d', branch]);
      if (!del.ok) {
        // -d refuses an unmerged branch, which is the point. Say so and keep it.
        notes.push(`branch ${branch} kept: ${del.stderr}`);
      } else {
        notes.push(`branch ${branch} deleted`);
      }
    }

    return { ok: true, notes };
  }

  return {
    git,
    currentBranch,
    branchExists,
    refExists,
    isClean,
    listWorktrees,
    mainCheckout,
    isIgnored,
    startWork,
    landDirect,
    cleanupWork,
  };
}
