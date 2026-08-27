/**
 * Shared plumbing for the command modules: config + provider in one step, and
 * the `@file` argument convention.
 */
import { readFileSync } from 'node:fs';

import { findIssueCheckouts } from '../../lib/branch.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { makeProvider } from '../../lib/provider.mjs';

/** Thrown for expected, user-facing failures — dev.mjs prints `.message` alone. */
export class UserError extends Error {}

/**
 * Load the config and build the provider for it.
 *
 * This is the seam. It used to hard-require a YouTrack URL and then a resolved
 * token before any command could run, which is why the tool could only ever
 * have one backend: GitHub has neither.
 *
 * It validates nothing itself now, deliberately. "A project is named" looked
 * universal, but the key holding the name is not: YouTrack calls it `project`,
 * GitHub calls it `github.repo`, and a core check spelled against one of them
 * rejects every config for the other. Each adapter already refuses to build
 * without the identity *it* needs, and that is the check — one place per
 * backend, named after the key the user must actually add.
 *
 * @returns {Promise<{config: object, file: string|null, root: string, provider: object}>}
 */
export async function context() {
  const { config, file, root } = loadConfig();

  const r = await makeProvider(config);
  if (!r.ok) throw new UserError(r.error);

  return { config, file, root, provider: r.provider };
}

/**
 * Resolve an argument that may be literal text or `@path` to read a file.
 * A leading `@@` escapes to a literal '@'.
 */
export function readArg(value, what = 'file') {
  if (typeof value !== 'string') return value;
  if (value.startsWith('@@')) return value.slice(1);
  if (!value.startsWith('@')) return value;

  const path = value.slice(1);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new UserError(`${what} not found: ${path}`);
  }
}

/**
 * Which repo a command acts on, and where it is on disk.
 *
 * `repos` is a list of paths relative to the project root; `.` means the root
 * itself. A project that configures none is a single repo at its root — the
 * same rule `scripts/cmd/sync.mjs` applies, kept in one place now that two more
 * commands need it.
 *
 * Refusing an unknown `--repo` rather than falling back to the root is
 * deliberate: silently working on the wrong repo is worse than stopping.
 */
export function resolveRepo(config, root, wanted) {
  const paths = config.repos?.length ? config.repos.map((r) => r.path) : ['.'];

  if (wanted && !paths.includes(wanted)) {
    throw new UserError(`--repo "${wanted}" is not configured (have: ${paths.join(', ')})`);
  }
  if (!wanted && paths.length > 1) {
    throw new UserError(
      `this project configures ${paths.length} repos (${paths.join(', ')}) — pass --repo <path>`,
    );
  }

  const path = wanted ?? paths[0];
  return { path, dir: path === '.' ? root : `${root}/${path}` };
}

/** Unwrap a { ok, data, error } result or throw its message. */
export function must(result) {
  if (!result.ok) throw new UserError(result.error);
  return result.data;
}

/**
 * The one local checkout that carries `id`, or null.
 *
 * `abandon` and `resume` both start here and disagree about only one thing:
 * whether "none" is a failure. So the lookup is shared and that judgement is
 * not — this returns null and each caller says what null means to it.
 *
 * Ambiguity is fatal for both, and refused rather than resolved. Two branches
 * for one ticket is somebody's half-finished second attempt, and picking one by
 * a rule nobody asked for is how a recovery verb deletes the wrong branch.
 *
 * @returns {Promise<{branch: string, path: string|null} | null>}
 */
export async function locateWork({ config, vcs, repoDir, id }) {
  const [worktrees, branches] = await Promise.all([
    vcs.listWorktreeEntries(repoDir),
    vcs.listBranches(repoDir),
  ]);

  const matches = findIssueCheckouts(config, { worktrees, branches }, id);
  if (matches.length > 1) {
    throw new UserError(
      `${id} has more than one branch in ${repoDir} — say which by hand:\n` +
        matches.map((m) => `  ${m.branch}${m.path ? `   (${m.path})` : ''}`).join('\n'),
    );
  }
  return matches[0] ?? null;
}

/**
 * At most `max` of `lines`, with a line saying how many were left out.
 *
 * A refusal that lists forty modified files scrolls the reason for the refusal
 * off the screen; one that lists three and says "and 37 more" does not. Shared
 * so the two recovery verbs count and word it identically.
 */
export function preview(lines, max = 10) {
  const shown = lines.slice(0, max);
  const rest = lines.length - shown.length;
  return rest > 0 ? [...shown, `  … and ${rest} more`] : shown;
}
