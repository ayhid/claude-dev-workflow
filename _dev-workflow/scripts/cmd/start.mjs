/**
 * Put a working copy in place for an issue, and move the ticket to the start rung.
 *
 *   dev.mjs start <ISSUE-ID> [--type T] [--mode worktree|branch] [--repo PATH] [--print]
 *
 * The branch name is *rendered*, not improvised: `branch.pattern` finally has a
 * consumer, so the name a project gets is the name its config describes, the
 * same on every run and in every session.
 *
 * Output ends with a `cd <dir>` line. In worktree mode that directory is not the
 * repo root, and a caller that keeps working in the root edits the wrong
 * checkout — so the path is the last thing printed, deliberately.
 */
import {
  issueIdFromBranch,
  issueTypeOf,
  renderBranch,
  worktreePathFor,
} from '../../lib/branch.mjs';
import { resolveBranchType } from '../../lib/config.mjs';
import { canonicalId } from '../../lib/issueid.mjs';
import { sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, resolveRepo, UserError } from './common.mjs';

function parseArgs(args) {
  const opts = { print: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--print' || a === '--dry-run') opts.print = true;
    else if (a === '--type') opts.type = args[++i];
    else if (a === '--mode') opts.mode = args[++i];
    else if (a === '--repo') opts.repo = args[++i];
    else if (a.startsWith('-')) throw new UserError(`unknown flag ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  const rawId = rest[0];
  if (!rawId) {
    throw new UserError(
      'usage: dev.mjs start <ISSUE-ID> [--type T] [--mode worktree|branch] [--repo PATH] [--print]',
    );
  }

  const { config, root, provider } = await context();
  // One spelling from here on — see canonicalId in lib/issueid.mjs (#43).
  const id = canonicalId(config, rawId);
  const configured = resolveRepo(config, root, opts.repo);
  const vcs = makeVcs({ run: sh });

  // Started from inside an existing worktree, the config walk resolves the root
  // to that worktree — it carries a tracked copy of the config file. Branches
  // and worktrees belong to the main checkout, so normalise before touching git.
  const repo = { ...configured, dir: await vcs.mainCheckout(configured.dir) };

  const issue = await provider.getIssue(id);
  if (!issue.ok) throw new UserError(issue.error);

  // An explicit --type is a branch type already; anything read off the issue is
  // an issue type and has to go through the configured mapping.
  let type = opts.type;
  if (!type) {
    const resolved = resolveBranchType(config, issueTypeOf(config, issue.data));
    if (!resolved.ok) throw new UserError(resolved.error);
    type = resolved.type;
  }

  const rendered = renderBranch(config, { id, type, title: issue.data.title });
  if (!rendered.ok) throw new UserError(rendered.error);
  const branch = rendered.branch;

  const mode = opts.mode ?? config.branch?.mode ?? 'worktree';
  const base = config.branch?.base ?? 'main';
  const worktreePath = worktreePathFor(config, { repoDir: repo.dir, branch });
  const workDir = mode === 'worktree' ? worktreePath : repo.dir;

  // Sanity check the name round-trips. `dev.mjs land` with no ID and /dev-done
  // both read the issue back out of the branch, so a pattern that renders a name
  // nothing can parse breaks the far end of the workflow — better to say so here
  // than to discover it at the close-out.
  const parsedBack = issueIdFromBranch(config, branch);
  const roundTrips = parsedBack === id;

  const L = [];
  L.push(`issue:    ${id} — ${issue.data.title}`);
  L.push(`repo:     ${repo.path} (${repo.dir})`);
  L.push(`branch:   ${branch}   (base: ${base}, type: ${type})`);
  L.push(`mode:     ${mode}${mode === 'worktree' ? ` → ${worktreePath}` : ''}`);
  if (!roundTrips) {
    L.push(
      `warning:  "${branch}" reads back as ${parsedBack ?? 'no issue'}, not ${id} — ` +
        'sync and /dev-done infer the ticket from the branch name',
    );
  }

  if (opts.print) {
    L.push('', '(--print: nothing was created)');
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }

  const started = await vcs.startWork({ dir: repo.dir, branch, base, mode, worktreePath });
  if (!started.ok) throw new UserError(started.error);
  L.push(`created:  ${started.created ? 'new branch' : 'existing branch, reused'}`);

  // The worktree directory is a checkout inside the repo. Whether it is ignored
  // is the user's call to make in their own .gitignore — this tool writes only
  // `_dev-workflow/` and `.claude/skills/dev-*`, so it says the line rather than
  // adding it.
  if (mode === 'worktree') {
    const dir = config.branch?.worktreeDir ?? '.worktrees';
    if (!(await vcs.isIgnored(repo.dir, `${dir}/`))) {
      process.stderr.write(
        `dev start: ${dir}/ is not ignored by git — add this line to ${repo.path}/.gitignore:\n${dir}/\n`,
      );
    }
  }

  const moved = await provider.setState(id, 'start');
  // A failed transition is not a reason to throw away a working copy that now
  // exists: report it and let the caller retry the one step that failed.
  L.push(moved.ok ? `state:    ${moved.state}` : `state:    NOT MOVED — ${moved.error}`);

  L.push('', `cd ${started.dir}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return moved.ok ? 0 : 1;
}
