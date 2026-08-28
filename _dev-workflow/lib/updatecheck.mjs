/**
 * Is a newer version of the workflow published than the one installed here?
 *
 * Two consumers, one implementation: `dev.mjs version` asks deliberately and
 * prints a full report, and the commands a session opens with — `config`,
 * `status`, `standup` — ask incidentally and print at most one line on stderr.
 * The registry lookup, the upgrade command's spelling and the cache all live
 * here so those two never drift into two different answers.
 *
 * Four rules this file exists to hold:
 *
 * 1. **It may never fail the command it rides on.** Offline, a non-200, an
 *    unparseable body, a corrupt cache, an unwritable `_config/` — each means no
 *    banner and nothing else. The host command's stdout, stderr and exit code
 *    are what they would have been. This is `lib/metrics.mjs`'s rule, for the
 *    same reason: an instrument that breaks what it measures is worse than none.
 * 2. **The network is touched at most once a day.** A session runs three of
 *    these commands; three lookups and three banners is how a notice gets tuned
 *    out. The cache holds the answer and the fact that it was already said.
 * 3. **IO is injected** — fetch, clock and file access (lib/provider.mjs rule
 *    1). Every branch below is testable with no network and no filesystem.
 * 4. **Silence is the default.** Up to date, ahead of the registry, no manifest,
 *    or anything unexpected: nothing is printed. Only a version this install is
 *    demonstrably behind produces a line.
 *
 * Zero dependencies: node: builtins only, like everything else under `lib/`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { MANIFEST_PATH, PAYLOAD_DIR, compareVersions } from './manifest.mjs';

/** The dist-tag endpoint: ~30 bytes, no auth, CDN-cached, no meaningful rate limit. */
export const REGISTRY_URL = 'https://registry.npmjs.org/-/package/claude-dev-workflow/dist-tags';

export const NETWORK_TIMEOUT_MS = 2500;

/**
 * The one npx spelling that actually re-resolves. See bin/install.mjs for why
 * `@latest` is load-bearing rather than decorative.
 *
 * There are exactly two copies of this string in the repo — this one, which
 * every shipped consumer prints, and `bin/install.mjs`'s, which the installer
 * prints before any payload exists to import from. `tests/updatecheck.test.mjs`
 * fails if they drift, because a third spelling would be one that silently
 * re-runs whatever npx cached first.
 */
export const UPGRADE_COMMAND = 'npx claude-dev-workflow@latest --update';

/**
 * Where the answer is remembered, next to the manifest it is compared against.
 *
 * Inside `_dev-workflow/` because that is a directory we already own, and
 * *ignored* rather than committed: consumers commit the payload, and a file
 * rewritten daily would leave that directory permanently dirty and destroy the
 * drift signal `git diff _dev-workflow/` gives. The installer writes only the
 * paths it plans, so this never appears in the manifest and `detectDrift` never
 * sees it — but a `.gitignore` line is the user's to add, and the docs say so.
 */
export const CACHE_PATH = join(PAYLOAD_DIR, '_config', 'updatecheck.json');

/** One day. Long enough that a session never pays twice, short enough to matter. */
export const TTL_MS = 24 * 60 * 60 * 1000;

const readTextFile = (path) => readFileSync(path, 'utf8');
const writeTextFile = (path, text) => writeFileSync(path, text);

/**
 * The latest published version, or null.
 *
 * The registry rather than GitHub releases: `/releases/latest` is 60 requests an
 * hour *per IP* unauthenticated, which a shared CI runner or an office NAT burns
 * through, and it would have to strip a leading `v` off a tag. Because
 * `@semantic-release/git` writes the bump back to `main`, a `github:` install's
 * manifest version converges on the same number, so one source answers for both
 * install paths.
 *
 * The transport is injected for the reason every adapter's is (lib/provider.mjs
 * rule 1): it makes every branch below testable with no network. Every failure —
 * DNS, timeout, non-200, unparseable body — is null, never a throw.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string|null>}
 */
export async function latestVersion(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (!res?.ok) return null;
    const body = await res.json();
    const v = body?.latest;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * The project root of the *install*, which is not always the config's root.
 *
 * Walks up looking for the manifest, so a command answers about the install it
 * is actually running from. Null when there is none — the caller decides what to
 * fall back to.
 */
export function findInstallRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, MANIFEST_PATH))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The banner, or null when there is nothing to say.
 *
 * `compareVersions` returns null for anything that is not a plain semver triple,
 * so a missing manifest, a git sha and a prerelease tag all fall through to
 * silence rather than to a confident wrong answer — and `1` (ahead of the
 * registry, which is what a `github:` install tracking `main` looks like) does
 * too. Only `-1` speaks.
 *
 * The wording is the one `scripts/cmd/version.mjs` prints, for the reason the
 * command itself is a single constant: one phrasing, one upgrade command.
 */
export function banner(installed, latest) {
  if (compareVersions(installed, latest) !== -1) return null;
  return `An update is available: ${installed} → ${latest} — ${UPGRADE_COMMAND}`;
}

/**
 * Read the cache.
 *
 * Absent and corrupt are told apart because they mean different things: absent
 * is the normal first run and earns a lookup, corrupt is a failed check and
 * earns silence. Anything whose shape is not what was written — hand-edited,
 * half-written by a killed process, a JSON array — counts as corrupt.
 *
 * @returns {{found: boolean, corrupt: boolean, cache?: {latest: string|null, checkedAt: number, announced: string|null}}}
 */
export function readCache(root, { readFile = readTextFile } = {}) {
  let raw;
  try {
    raw = readFile(join(root, CACHE_PATH));
  } catch {
    return { found: false, corrupt: false };
  }

  try {
    const parsed = JSON.parse(raw);
    const checkedAt = parsed?.checkedAt;
    if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) {
      return { found: false, corrupt: true };
    }
    return {
      found: true,
      corrupt: false,
      cache: {
        checkedAt,
        latest: typeof parsed.latest === 'string' ? parsed.latest : null,
        announced: typeof parsed.announced === 'string' ? parsed.announced : null,
      },
    };
  } catch {
    return { found: false, corrupt: true };
  }
}

/**
 * Write the cache. Returns whether it landed — the caller needs to know, because
 * the write is what records that the banner was said.
 */
export function writeCache(root, record, { writeFile = writeTextFile } = {}) {
  try {
    writeFile(join(root, CACHE_PATH), `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole check: what, if anything, this command should print on stderr.
 *
 * @param {object} opts
 * @param {string} opts.root         the install root — where `_dev-workflow/` is
 * @param {string|null} opts.installed  the manifest's version
 * @param {number} [opts.now]        the clock, injected
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.env]
 * @param {(path: string) => string} [opts.readFile]
 * @param {(path: string, text: string) => void} [opts.writeFile]
 * @returns {Promise<string|null>}
 */
export async function checkForUpdate({
  root,
  installed = null,
  now = Date.now(),
  fetchImpl = fetch,
  env = process.env,
  readFile = readTextFile,
  writeFile = writeTextFile,
} = {}) {
  // No manifest means no install that could be behind one. Checked before
  // anything else so the common "this project has no payload" case costs nothing.
  if (!installed) return null;
  if (env.DEV_WORKFLOW_NO_BANNER) return null;

  const read = readCache(root, { readFile });

  // A corrupt record is a failed check: silent now, like every other failure.
  // The reset is what stops that silence being permanent — `checkedAt: 0` is
  // always stale, so the next command does a real lookup and heals the file.
  if (read.corrupt) {
    writeCache(root, { latest: null, checkedAt: 0, announced: null }, { writeFile });
    return null;
  }

  const cache = read.cache ?? null;
  // A timestamp in the future is a clock that moved, not a fresh cache: without
  // the upper bound it would read as fresh forever.
  const fresh = Boolean(cache) && cache.checkedAt <= now && now - cache.checkedAt < TTL_MS;

  let latest;
  let announced;
  let checkedAt;

  if (fresh) {
    ({ latest, announced, checkedAt } = cache);
  } else {
    // The one place a network call can happen, and only when the cache cannot
    // answer. Suppressed outright by DEV_WORKFLOW_NO_NETWORK, which then leaves
    // nothing to report rather than reporting something stale.
    if (env.DEV_WORKFLOW_NO_NETWORK) return null;
    latest = await latestVersion(fetchImpl);
    if (!latest) return null;
    announced = null;
    checkedAt = now;
  }

  const text = banner(installed, latest);

  if (!text) {
    // Up to date or ahead. Still record the lookup, so the next two commands in
    // this session go nowhere near the network to reach the same conclusion.
    if (!fresh) writeCache(root, { latest, checkedAt, announced: latest }, { writeFile });
    return null;
  }

  // Once per cache window, not once per command: a single /dev-task runs three
  // of these.
  if (announced === latest) return null;

  // The write is what records the announcement, so a cache that cannot be
  // written is a banner that cannot be printed — the alternative is a line that
  // reprints on every command forever, which is worse than not being told.
  // `checkedAt` is carried over rather than refreshed: saying the line does not
  // extend the window.
  if (!writeCache(root, { latest, checkedAt, announced: latest }, { writeFile })) return null;

  return text;
}
