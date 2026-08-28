/**
 * What the installer needs from the GitHub CLI, and nothing more.
 *
 * The wizard verifies a GitHub project the way it verifies a YouTrack one: talk
 * to the real thing before writing a config that claims it works. It cannot use
 * `lib/github.mjs` for that — the adapter refuses to construct until a complete
 * config exists, which is exactly what is being assembled here.
 *
 * So this is the same shape as `lib/youtrack.mjs`'s helpers — every call returns
 * `{ok: true, data}` or `{ok: false, error}`, never throws — over `execFile`
 * with an argument array. No interpolated shell string ever reaches a shell: a
 * repository slug is user input, and `owner/name; rm -rf ~` is a valid thing to
 * type into a prompt.
 *
 * The version floor is imported rather than restated. `MIN_GH` is the adapter's
 * own gate, and a wizard that accepted a `gh` the runtime then refuses would
 * write a config that cannot work.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MIN_GH, atLeast, parseVersion } from '../../lib/github.mjs';

export { MIN_GH };

const run = promisify(execFile);

/** One `gh` invocation. Never throws; a missing binary is an error like any other. */
async function gh(args, { timeout = 20_000 } = {}) {
  try {
    const { stdout } = await run('gh', args, { timeout, encoding: 'utf8' });
    return { ok: true, data: stdout };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, error: 'the GitHub CLI (gh) is not on PATH — see https://cli.github.com' };
    }
    return { ok: false, error: (err?.stderr || err?.message || 'gh failed').trim() };
  }
}

/**
 * `gh` is installed and new enough.
 *
 * @returns {Promise<{ok: true, data: string} | {ok: false, error: string}>}
 *   `data` is the version as printed, e.g. `2.62.0`.
 */
export async function ghVersion() {
  const r = await gh(['--version']);
  if (!r.ok) return r;

  const got = parseVersion(r.data);
  if (!got) return { ok: true, data: r.data.split('\n')[0].trim() };
  if (!atLeast(got, MIN_GH)) {
    return {
      ok: false,
      error: `gh ${got.join('.')} is too old — ${MIN_GH.join('.')} or newer is needed to tell "closed as completed" from "closed as not planned"`,
    };
  }
  return { ok: true, data: got.join('.') };
}

/** Who `gh` is logged in as, if anyone. */
export async function ghAuthStatus() {
  const r = await gh(['auth', 'status']);
  if (!r.ok) return { ok: false, error: 'gh is not authenticated — run: gh auth login' };
  // The login line is on stdout in recent versions and stderr in older ones;
  // either way a miss costs a nicer sentence, never the verification itself.
  const login = /account (\S+)/.exec(r.data)?.[1] ?? /as (\S+)/.exec(r.data)?.[1] ?? null;
  return { ok: true, data: login };
}

/**
 * The repository exists and is writable by whoever `gh` is logged in as.
 *
 * `viewerPermission` of READ is reported as a failure: the workflow moves
 * labels and comments, so read access produces a config that fails on first use.
 */
export async function ghRepoView(slug) {
  const r = await gh(['repo', 'view', slug, '--json', 'nameWithOwner,viewerPermission']);
  if (!r.ok) return r;

  let parsed;
  try {
    parsed = JSON.parse(r.data || 'null');
  } catch (err) {
    return { ok: false, error: `could not parse gh output: ${err.message}` };
  }
  if (!parsed?.nameWithOwner) return { ok: false, error: `no such repository: ${slug}` };
  if (parsed.viewerPermission === 'READ') {
    return { ok: false, error: `you have read-only access to ${parsed.nameWithOwner} — the workflow writes` };
  }
  return { ok: true, data: parsed };
}

/**
 * The labels this repository actually has, sorted.
 *
 * Read rather than proposed: a rung's label is required config precisely
 * because a label named after its rung is a guess that is right often enough to
 * be dangerous. 100 is `gh`'s own page size and well past any sane label list.
 */
export async function ghLabels(slug) {
  const r = await gh(['label', 'list', '-R', slug, '--json', 'name', '--limit', '100']);
  if (!r.ok) return r;
  try {
    const names = (JSON.parse(r.data || '[]') ?? []).map((l) => l.name).filter(Boolean);
    return { ok: true, data: names.sort((a, b) => a.localeCompare(b)) };
  } catch (err) {
    return { ok: false, error: `could not parse gh output: ${err.message}` };
  }
}

/** The exact command that creates one label — printed for the user to run, never run here. */
export const createLabelCommand = (name, slug) =>
  `gh label create ${JSON.stringify(name)} -R ${slug} --color ededed`;
