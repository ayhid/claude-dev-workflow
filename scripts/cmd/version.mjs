/**
 * What version of the workflow is installed here, and is there a newer one?
 *
 *   dev.mjs version              installed vs latest, plus files you have edited
 *   dev.mjs version --json       the same, machine-readable
 *   dev.mjs version --offline    skip the network check entirely
 *   dev.mjs version --upgrade    run the installer to bring the payload up to date
 *
 * **Named `version`, not `upgrade`.** `update` already means "write to the issue
 * tracker" and lives one row away in dev.mjs's command table; `update` and
 * `upgrade` differ by one letter, and a mistyped verb that rewrites 25 files
 * instead of moving a ticket is not a mistake worth making possible. The action
 * is an explicit flag on a read-only noun instead.
 *
 * Three rules this file exists to hold:
 *
 * 1. **Offline is not an error.** A failed check prints "unknown" and exits 0.
 *    dev.mjs turns a throw into exit 1, and a skill reading that would conclude
 *    the command is broken because the user is on a plane.
 * 2. **Nothing here writes.** `--upgrade` spawns the real installer, which owns
 *    `isOwnedPath` and the delete pass. Duplicating that boundary into every
 *    consumer's project is precisely what the boundary exists to prevent.
 * 3. **The version is read back.** After an upgrade the manifest is re-read and
 *    the version *found* is reported, never the one that was asked for.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../../lib/config.mjs';
import { MANIFEST_PATH, PAYLOAD_DIR, compareVersions, detectDrift, readManifest } from '../../lib/manifest.mjs';
import { has, sh } from '../../lib/sh.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { UserError } from './common.mjs';

/** The dist-tag endpoint: ~30 bytes, no auth, CDN-cached, no meaningful rate limit. */
const REGISTRY_URL = 'https://registry.npmjs.org/-/package/claude-dev-workflow/dist-tags';

/**
 * The one npx spelling that actually re-resolves. See bin/install.mjs for why
 * `@latest` is load-bearing rather than decorative.
 *
 * `-y` is in the args we spawn — an unattended run must not stall on npx's
 * "install this package?" prompt — but not in the command we *print*, which has
 * to match what bin/install.mjs tells the user, byte for byte.
 */
export const UPGRADE_ARGS = ['-y', 'claude-dev-workflow@latest', '--update'];
const UPGRADE_COMMAND = 'npx claude-dev-workflow@latest --update';

const NETWORK_TIMEOUT_MS = 2500;

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
 * Walks up looking for the manifest, so the command answers about the install it
 * is actually running from. Falls back to the config's root, then the start
 * directory, so it still says something useful in a project with neither.
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
 * Render the report. Pure, and stable byte-for-byte for the same inputs — the
 * output is read by a skill as often as by a person.
 *
 * @param {{installed: string|null, latest: string|null, installDate?: string,
 *          lastUpdated?: string, modified?: string[], missing?: string[],
 *          checked: boolean}} state
 */
export function render(state) {
  const lines = [];
  const dates = [state.installDate && `installed ${state.installDate.slice(0, 10)}`, state.lastUpdated && `updated ${state.lastUpdated.slice(0, 10)}`]
    .filter(Boolean)
    .join(', ');

  lines.push(`installed  ${state.installed ?? 'unknown — no manifest found'}${dates ? `  (${dates})` : ''}`);

  if (!state.checked) lines.push('latest     not checked (offline)');
  else if (!state.latest) lines.push('latest     unknown — could not reach the npm registry');
  else lines.push(`latest     ${state.latest}  (npm registry)`);

  const cmp = compareVersions(state.installed, state.latest);
  if (cmp === 0) lines.push('', 'Up to date.');
  else if (cmp === -1) {
    lines.push('', `An update is available: ${state.installed} → ${state.latest}`);
  } else if (cmp === 1) {
    // A `github:` install tracks main, which semantic-release bumps before the
    // registry sees it. Say so rather than printing something nonsensical.
    lines.push('', 'Ahead of the registry — this looks like a git install.');
  }

  const modified = [...(state.modified ?? [])].sort();
  const missing = [...(state.missing ?? [])].sort();
  if (modified.length) {
    lines.push('', `${modified.length} file(s) differ from the manifest — an update will keep them:`);
    for (const f of modified) lines.push(`  ${f}`);
  }
  if (missing.length) {
    lines.push('', `${missing.length} file(s) recorded in the manifest are gone — an update restores them:`);
    for (const f of missing) lines.push(`  ${f}`);
  }

  if (cmp === -1 || missing.length) {
    lines.push('', `Upgrade with:  ${UPGRADE_COMMAND}`, `           or:  dev.mjs version --upgrade`);
  }

  return lines.join('\n');
}

/**
 * Run the real installer against `root`.
 *
 * This module never writes a file itself. `isOwnedPath`, the write plan and the
 * delete pass live in `bin/lib/payload.mjs`, which is deliberately not shipped —
 * a second writer inside the payload would mean two implementations of the one
 * rule about what we may touch in someone's project.
 *
 * Safe despite rewriting its own source mid-run: ESM reads a module at import
 * time, so this file is already fully in memory before npx is spawned.
 */
async function upgrade(root, { run = sh, hasBin = has, vcs } = {}) {
  const git = vcs ?? makeVcs({ run });

  // Consumers commit `_dev-workflow/` and `.claude/skills/dev-*`. An upgrade
  // produces a diff they have to review, so it must not land on top of edits
  // already sitting in those directories.
  const owned = [PAYLOAD_DIR, join('.claude', 'skills')].filter((p) => existsSync(join(root, p)));
  if (owned.length) {
    const state = await git.isClean(root, { paths: owned });
    if (state.ok && !state.clean) {
      throw new UserError(
        `refusing to upgrade: ${owned.join(' and ')} have uncommitted changes.\n` +
          `${state.dirty.map((l) => `  ${l}`).join('\n')}\n` +
          'Commit or stash them first — an upgrade rewrites these files.',
      );
    }
  }

  if (!(await hasBin('npx'))) {
    return `npx is not on PATH. Run this where it is:\n  ${UPGRADE_COMMAND} --dir ${root}`;
  }

  const before = readManifest(root)?.installation?.version ?? null;
  const r = await run('npx', [...UPGRADE_ARGS, '--dir', root], { timeout: 300_000 });

  // Never swallow stderr from a write: the useful message is always underneath.
  if (!r.ok) {
    throw new UserError(`${UPGRADE_COMMAND} failed (exit ${r.code}):\n${r.stderr || r.stdout || '(no output)'}`);
  }

  const after = readManifest(root)?.installation?.version ?? null;
  const lines = [r.stdout, ''].filter(Boolean);

  if (after && before && after === before) {
    lines.push(`Still on ${after} — nothing changed.`);
  } else {
    lines.push(`Now on ${after ?? 'unknown'}${before ? ` (was ${before})` : ''}.`);
    lines.push(`${PAYLOAD_DIR}/ and .claude/skills/dev-* have changed. Review the diff and commit it.`);
  }
  return lines.join('\n');
}

export async function run(args = []) {
  const wants = (f) => args.includes(f);

  const { root: configRoot } = loadConfig();
  const root = findInstallRoot(process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) ?? configRoot;

  const manifest = readManifest(root);
  const installed = manifest?.installation?.version ?? null;
  const drift = manifest ? detectDrift(root, manifest) : { modified: [], missing: [], clean: [] };

  const checked = !wants('--offline') && !process.env.DEV_WORKFLOW_NO_NETWORK;
  const latest = checked ? await latestVersion() : null;

  const state = {
    root,
    installed,
    latest,
    checked,
    installDate: manifest?.installation?.installDate,
    lastUpdated: manifest?.installation?.lastUpdated,
    modified: drift.modified,
    missing: drift.missing,
  };

  if (wants('--json')) {
    process.stdout.write(`${JSON.stringify({ ...state, upgradeCommand: UPGRADE_COMMAND }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(state)}\n`);
  }

  if (wants('--upgrade')) {
    if (!manifest) throw new UserError(`no install found under ${root} — run \`${UPGRADE_COMMAND}\` there first`);
    process.stdout.write(`\n${await upgrade(root)}\n`);
  }

  // Always zero on a healthy report. "An update exists" is information, not a
  // failure, and dev.mjs would print it as `dev version: …` on a throw.
  return 0;
}
