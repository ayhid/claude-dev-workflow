/**
 * Shared plumbing for the command modules: config + provider in one step, and
 * the `@file` argument convention.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findIssueCheckouts } from '../../lib/branch.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { readManifest } from '../../lib/manifest.mjs';
import {
  closeEvent,
  metricsEnabled,
  metricsFileOf,
  parseLog,
  renderEvent,
  roleOf,
} from '../../lib/metrics.mjs';
import { makeProvider } from '../../lib/provider.mjs';
import { checkForUpdate, findInstallRoot } from '../../lib/updatecheck.mjs';

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

  return { config, file, root, provider: withMetrics(r.provider, { config, root }) };
}

/**
 * The provider, with every state change it reports appended to the local log.
 *
 * This is a choke point, chosen for the reason `lib/vcs.mjs` puts its refusals
 * in one `git()` wrapper: `update`, `land`, `sync`, `start`, `resume` and
 * `abandon` all move tickets, and instrumenting each of them would be six
 * places for the seventh to be forgotten. Every command takes its provider from
 * `context()`, so wrapping here covers the ones that exist and the ones that do
 * not yet.
 *
 * It records the state that came **back**, not the rung that was asked for
 * (rule 3) — which also happens to be the only thing that works, since `sync`
 * passes a ladder state rather than a rung.
 *
 * Nothing here may fail a command. A log is a nice-to-have and a ticket
 * transition is not: a write that throws is reported on stderr and swallowed,
 * because failing a close because a log file was read-only would be an
 * instrument that broke the thing it was measuring.
 */
export function withMetrics(provider, { config, root, now = () => new Date() }) {
  if (!metricsEnabled(config)) return provider;

  const path = resolve(root, metricsFileOf(config));
  let annotation = {};

  return {
    ...provider,

    /**
     * What the caller knows and the provider cannot: whether the acceptance
     * criteria passed first time. Set by `update` and `land` from `--criteria`
     * just before the close, and consumed by the next state change only.
     *
     * A method on the wrapper rather than an argument to `setState`, because
     * `setState`'s signature is the provider contract and this is not part of
     * it — no adapter should have to know that a log exists.
     */
    annotate(fields = {}) {
      annotation = { ...annotation, ...fields };
    },

    async setState(id, rung, comment) {
      const result = await provider.setState(id, rung, comment);
      if (result.ok) {
        const { criteria = null } = annotation;
        annotation = {};
        record({ path, config, provider, id, state: result.state, criteria, at: now() });
      }
      return result;
    },
  };
}

/** Append one event, or say on stderr why it could not be appended. */
function record({ path, config, provider, id, state, criteria, at }) {
  const role = roleOf(config, state);
  // A transition to something the project has no rung for — parked in Blocked,
  // moved by hand — is not an event this log has an opinion about.
  if (!role) return;

  try {
    const existed = existsSync(path);
    const previous = existed ? readFileSync(path, 'utf8') : '';
    const { events } = parseLog(previous);

    const line =
      role === 'start'
        ? renderEvent({ role, id, state, at, provider: provider.name })
        : closeEvent({ events, role, id, state, at, provider: provider.name, criteria });

    // A write this process was killed halfway through leaves a line with no
    // newline on it. Appending straight onto that would join the two into one
    // unreadable line, turning a truncated record into a *lost* record — so the
    // separator is repaired first. `lib/notes.mjs` fixes the same thing for the
    // same reason.
    const needsBreak = previous.length > 0 && !previous.endsWith('\n');
    appendFileSync(path, needsBreak ? `\n${line}` : line);

    if (!existed) {
      // Said once, on creation, rather than written into anyone's .gitignore:
      // this tool writes to `_dev-workflow/` and `.claude/skills/dev-*` and
      // nowhere else, and worktree mode sets the precedent for saying the line.
      process.stderr.write(
        `dev: created ${path} — one line per ticket transition, local and never sent anywhere.\n` +
          'Add it to .gitignore: every developer appends to it, so a shared copy conflicts on merge.\n',
      );
    }
  } catch (err) {
    process.stderr.write(`dev: could not record the transition of ${id}: ${err.message}\n`);
  }
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

  // `||`, not `??`: an unspecified repo reaches here as `''` from a command
  // whose flag defaults to the empty string, and `??` only catches null and
  // undefined. The empty string then became the path, and the directory became
  // `<root>/` — a repo that is nearly the right one, which is the worst kind.
  const path = wanted || paths[0];
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

/**
 * Tell the user, at most once a day, that a newer workflow is published.
 *
 * Called by `config`, `status` and `standup` — the commands a skill runs at its
 * top, so a session is told once without attaching a network check to `fetch`,
 * `create` or `land`. A choke point for the reason `withMetrics` above is one:
 * three call sites today, and the fourth session-opening command someone adds
 * later would otherwise be the one place this was forgotten. The trade accepted
 * knowingly is that it is a call per command rather than a dispatcher hook — the
 * dispatcher would put a lookup behind every command, which is the thing being
 * avoided.
 *
 * **stderr, always.** `create` prints only the new issue ID on stdout and
 * `config --json` is parsed by skills; a banner on stdout would corrupt both.
 *
 * It swallows everything. A notice that can fail the command it rides on is
 * worse than no notice — the rule `lib/metrics.mjs` already holds.
 *
 * @param {string} configRoot the project root, as the command already resolved it
 */
export async function emitUpdateBanner(configRoot) {
  try {
    // The install root is not always the config's root: the same walk `version`
    // does, so both commands answer about the same install.
    const root = findInstallRoot(process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) ?? configRoot;
    const installed = readManifest(root)?.installation?.version ?? null;
    const text = await checkForUpdate({ root, installed });
    if (text) process.stderr.write(`${text}\n`);
  } catch {
    // Deliberately empty: see above.
  }
}

/**
 * The repo-relative path an anchor names, or null if it does not name one.
 *
 * An anchor is either a `file:line` or **the command that shows the claim to be
 * true**, and the two have to be told apart before either can be checked. The
 * rule is deliberately narrow, because a false refusal here is worse than a
 * miss: it would block a claim that was correctly evidenced.
 *
 *   - anything containing whitespace is a command (`npm test`, `git ls-files`)
 *   - anything containing `://` is a URL
 *   - a bare word with no `/` and no extension is a command (`make`, `pytest`)
 *   - what is left is a path, with an optional `:12` or `:12-30` suffix
 */
export function anchorPath(anchor) {
  const text = String(anchor ?? '').trim();
  if (!text || /\s/.test(text) || text.includes('://')) return null;

  const path = text.replace(/:\d+(-\d+)?$/, '');
  if (!path) return null;
  if (!path.includes('/') && !/\.[A-Za-z0-9]+$/.test(path)) return null;
  return path;
}

/**
 * Refuse claims whose anchor names a file that is not there.
 *
 * The commonest failure of a model writing about a codebase is an invented
 * filename, and it is the one kind of wrong anchor a script can catch: the
 * claim reads as checked, and the thing that would check it does not exist.
 * Ten lines of `existsSync` for that is a good trade.
 *
 * Shared by `docs record` and `ingest record` so the two cannot disagree about
 * what an anchor is — the reason `lib/vcs.mjs` puts its refusals in one wrapper.
 *
 * Line numbers are **not** verified. `/dev-ingest-docs` deferred mechanical
 * re-verification of anchors deliberately, and this does not reopen it: a line
 * that drifted by three still points a reader at the right file.
 */
export function refuseMissingAnchors(claims, root) {
  const bad = [];
  for (const claim of claims ?? []) {
    const path = anchorPath(claim?.anchor);
    if (!path) continue;
    if (existsSync(resolve(root, path))) continue;
    bad.push(`  ${path}   for "${String(claim.text ?? '').trim().slice(0, 60)}"`);
  }
  if (!bad.length) return;

  throw new UserError(
    `${bad.length} claim(s) anchor a path that is not in the repo:\n${bad.join('\n')}\n` +
      'Find the real file, or record the claim as kind "intent" and say who asserted it.',
  );
}
