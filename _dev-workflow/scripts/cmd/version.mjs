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
import { join } from 'node:path';

import { loadConfig } from '../../lib/config.mjs';
import {
  PAYLOAD_DIR,
  compareVersions,
  detectDrift,
  readJson,
  readManifest,
  resolveInstallRoots,
} from '../../lib/manifest.mjs';
import { has, sh } from '../../lib/sh.mjs';
import { UPGRADE_COMMAND, findInstallRoot, latestVersion } from '../../lib/updatecheck.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { UserError } from './common.mjs';

/**
 * The args we spawn, as distinct from the command we print.
 *
 * `-y` belongs here and nowhere else — an unattended run must not stall on npx's
 * "install this package?" prompt — while `UPGRADE_COMMAND`, imported above, has
 * to match what bin/install.mjs tells the user byte for byte. The registry
 * lookup, the timeout and that string all live in lib/updatecheck.mjs now,
 * because the session-opening commands print the same notice and two copies of
 * this check would be two answers to one question.
 */
export const UPGRADE_ARGS = ['-y', 'claude-dev-workflow@latest', '--update'];

/** The binary a `brew install` or `npm install -g` puts on PATH. */
export const GLOBAL_BIN = 'claude-dev-workflow';

/** The version a manifest at `path` records, or null when there is none. */
const versionAt = (path) => readJson(path)?.installation?.version ?? null;

/**
 * The warning a global install earns when its two halves disagree, or null.
 *
 * In global mode the skills live in the project and the runtime they call lives
 * on the machine, each recorded by its own manifest. Nothing keeps those two
 * versions together but an upgrade that refreshes both, so a difference is the
 * normal way this shape goes wrong rather than an edge case — and it is silent:
 * a skill written for one release calling a `dev.mjs` from another fails, when
 * it fails, somewhere far from the cause. One wording, used by the report and
 * by the upgrade's read-back, so the two cannot describe it differently.
 */
export function skewWarning(project, runtime) {
  if (project === runtime) return null;
  return (
    `Skew: the project half is on ${project ?? 'nothing'} and the machine runtime is on ${runtime ?? 'nothing'} — ` +
    'skills from one release are calling a dev.mjs from another. Upgrade both together.'
  );
}

/**
 * Render the report. Pure, and stable byte-for-byte for the same inputs — the
 * output is read by a skill as often as by a person.
 *
 * `mode: 'global'` adds the machine half: `runtime` is its manifest's version
 * and `payloadRoot` where it lives. A local install has one manifest and prints
 * exactly what it always printed.
 *
 * @param {{installed: string|null, latest: string|null, installDate?: string,
 *          lastUpdated?: string, modified?: string[], missing?: string[],
 *          checked: boolean, mode?: string, runtime?: string|null,
 *          payloadRoot?: string}} state
 */
export function render(state) {
  const lines = [];
  const dates = [state.installDate && `installed ${state.installDate.slice(0, 10)}`, state.lastUpdated && `updated ${state.lastUpdated.slice(0, 10)}`]
    .filter(Boolean)
    .join(', ');
  const global = state.mode === 'global';

  lines.push(`installed  ${state.installed ?? 'unknown — no manifest found'}${dates ? `  (${dates})` : ''}`);
  if (global) lines.push(`runtime    ${state.runtime ?? 'unknown — no manifest found'}  (${state.payloadRoot})`);

  if (!state.checked) lines.push('latest     not checked (offline)');
  else if (!state.latest) lines.push('latest     unknown — could not reach the npm registry');
  else lines.push(`latest     ${state.latest}  (npm registry)`);

  // With two halves, the older one is what is behind: a current project calling
  // a stale runtime is not up to date.
  const current = global && compareVersions(state.runtime, state.installed) === -1 ? state.runtime : state.installed;
  const cmp = compareVersions(current, state.latest);
  if (cmp === 0) lines.push('', 'Up to date.');
  else if (cmp === -1) {
    lines.push('', `An update is available: ${current} → ${state.latest}`);
  } else if (cmp === 1) {
    // A `github:` install tracks main, which semantic-release bumps before the
    // registry sees it. Say so rather than printing something nonsensical.
    lines.push('', 'Ahead of the registry — this looks like a git install.');
  }

  const skew = global ? skewWarning(state.installed, state.runtime) : null;
  if (skew) lines.push('', skew);

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

  if (cmp === -1 || missing.length || skew) {
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
 *
 * In global mode (`roots.mode`) the one installer run refreshes the machine
 * runtime and the project half together — the installer reads the mode from the
 * project's config — and both manifests are read back afterwards, so a half the
 * run left behind is reported as skew rather than assumed to have moved.
 */
export async function upgrade(root, { run = sh, hasBin = has, vcs, latest = null, roots = resolveInstallRoots({ projectDir: root }) } = {}) {
  const git = vcs ?? makeVcs({ run });
  const global = roots.mode === 'global';
  const runtimeVersion = () => versionAt(roots.payloadManifest);

  // Consumers commit `_dev-workflow/`, `.claude/skills/dev-*` and
  // `.claude/agents/dev-*.md`. An upgrade produces a diff they have to review,
  // so it must not land on top of edits already sitting in those directories.
  //
  // Check all three owned roots regardless of whether they exist on disk: git can
  // still have them tracked, and a root that is fully deleted but uncommitted should
  // still block the upgrade. (`existsSync` alone would miss a root where all files
  // were deleted without being committed; the directory then disappears but git
  // still knows about the files.)
  const owned = [PAYLOAD_DIR, join('.claude', 'skills'), join('.claude', 'agents')];
  const state = await git.isClean(root, { paths: owned });
  if (state.ok && !state.clean) {
    throw new UserError(
      `refusing to upgrade: ${new Intl.ListFormat('en').format(owned)} have uncommitted changes.\n` +
        `${state.dirty.map((l) => `  ${l}`).join('\n')}\n` +
        'Commit or stash them first — an upgrade rewrites these files.',
    );
  }

  // A binary installed once — brew, npm -g — is preferred, but only when it
  // is already the latest version: it installs *its own* payload, so a global
  // binary that is behind would "upgrade" the project to something stale. With
  // no latest to compare against, `npx …@latest` is the one spelling that
  // provably resolves the newest, so it wins.
  const spawn = await chooseUpgrade({ run, hasBin, latest });
  if (!spawn) {
    return `neither ${GLOBAL_BIN} nor npx is on PATH. Run this where one is:\n  ${UPGRADE_COMMAND} --dir ${root}`;
  }

  const before = readManifest(root)?.installation?.version ?? null;
  const runtimeBefore = global ? runtimeVersion() : null;
  const r = await run(spawn.bin, [...spawn.args, '--dir', root], { timeout: 300_000 });

  // Never swallow stderr from a write: the useful message is always underneath.
  if (!r.ok) {
    throw new UserError(`${[spawn.bin, ...spawn.args].join(' ')} failed (exit ${r.code}):\n${r.stderr || r.stdout || '(no output)'}`);
  }

  const after = readManifest(root)?.installation?.version ?? null;
  // The machine half is read back like the project half: the version found,
  // never the one the run was expected to produce.
  const runtimeAfter = global ? runtimeVersion() : null;
  const lines = [r.stdout, ''].filter(Boolean);

  // "Nothing changed" is a claim about the whole install, so it needs both
  // halves to be where they were — a run that moved only the runtime changed
  // what every skill in the project calls.
  const projectSame = Boolean(after && before && after === before);
  if (projectSame && runtimeAfter === runtimeBefore) {
    lines.push(`Still on ${after} — nothing changed.`);
  } else if (projectSame) {
    lines.push(`Project half still on ${after}.`);
  } else {
    lines.push(`Now on ${after ?? 'unknown'}${before ? ` (was ${before})` : ''}.`);
    const rewritten = new Intl.ListFormat('en').format([`${PAYLOAD_DIR}/`, '.claude/skills/dev-*', '.claude/agents/dev-*.md']);
    lines.push(`${rewritten} have changed. Review the diff and commit it.`);
  }

  if (global) {
    lines.push(`Machine runtime at ${roots.payloadRoot}: now on ${runtimeAfter ?? 'unknown'}${runtimeBefore ? ` (was ${runtimeBefore})` : ''}.`);
    const skew = skewWarning(after, runtimeAfter);
    if (skew) lines.push(skew);
  }
  return lines.join('\n');
}

/**
 * Which installer to spawn: the global binary when it is on PATH and reports
 * `latest`, otherwise `npx …@latest`, otherwise nothing.
 *
 * @returns {Promise<{bin: string, args: string[]} | null>}
 */
export async function chooseUpgrade({ run, hasBin, latest }) {
  if (latest && (await hasBin(GLOBAL_BIN))) {
    const v = await run(GLOBAL_BIN, ['version'], { timeout: 10_000 });
    if (v.ok && v.stdout.trim() === latest) return { bin: GLOBAL_BIN, args: ['update'] };
  }
  if (await hasBin('npx')) return { bin: 'npx', args: UPGRADE_ARGS };
  return null;
}

export async function run(args = []) {
  const wants = (f) => args.includes(f);

  const { config, root: configRoot } = loadConfig();
  const root = findInstallRoot(process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) ?? configRoot;

  // Two manifests in global mode, one in local — where they are is the
  // resolver's answer, never a path spelled here.
  const roots = resolveInstallRoots({ projectDir: root, mode: config.install?.mode, env: process.env });
  const global = roots.mode === 'global';

  const manifest = readManifest(root);
  const installed = manifest?.installation?.version ?? null;
  const drift = manifest ? detectDrift(root, manifest) : { modified: [], missing: [], clean: [] };

  const checked = !wants('--offline') && !process.env.DEV_WORKFLOW_NO_NETWORK;
  const latest = checked ? await latestVersion() : null;

  const state = {
    root,
    installed,
    ...(global
      ? { mode: roots.mode, runtime: versionAt(roots.payloadManifest), payloadRoot: roots.payloadRoot }
      : {}),
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
    process.stdout.write(`\n${await upgrade(root, { latest, roots })}\n`);
  }

  // Always zero on a healthy report. "An update exists" is information, not a
  // failure, and dev.mjs would print it as `dev version: …` on a throw.
  return 0;
}
