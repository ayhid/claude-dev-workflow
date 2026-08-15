/**
 * Reading the install manifest — the one file both sides of the install agree on.
 *
 * `bin/lib/payload.mjs` *writes* `_dev-workflow/_config/manifest.json`; the installed
 * payload *reads* it back to answer "what version is this project on, and which
 * files has someone edited since?". Two independent readers of one on-disk
 * schema is exactly the drift CLAUDE.md warns about for branch/commit types, so
 * the schema is understood in one place and that place ships.
 *
 * What deliberately does **not** live here: `isOwnedPath`, the write plan and the
 * delete pass. Those stay in `bin/lib/payload.mjs`, unshipped, so there is
 * exactly one implementation of the boundary that decides what the installer may
 * touch in someone's project.
 *
 * Zero dependencies: node: builtins only, like everything else under `lib/`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the payload lands, relative to the project root. Fixed, so the skills need no templating. */
export const PAYLOAD_DIR = '_dev-workflow';
export const MANIFEST_PATH = join(PAYLOAD_DIR, '_config', 'manifest.json');

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Read a JSON file, or return `fallback` if it is missing or unparseable. */
export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The manifest of the install in `projectDir`, or null if there is none. */
export function readManifest(projectDir) {
  return readJson(join(projectDir, MANIFEST_PATH));
}

/**
 * Compare what is on disk against what the manifest recorded.
 *
 * @returns {{modified: string[], missing: string[], clean: string[]}}
 */
export function detectDrift(projectDir, manifest) {
  const modified = [];
  const missing = [];
  const clean = [];

  for (const entry of manifest?.files ?? []) {
    const abs = join(projectDir, entry.path);
    if (!existsSync(abs)) {
      missing.push(entry.path);
      continue;
    }
    if (sha256(readFileSync(abs)) === entry.sha256) clean.push(entry.path);
    else modified.push(entry.path);
  }

  return { modified, missing, clean };
}

/**
 * Order two versions: -1 if `a` is older, 0 if equal, 1 if newer, null if
 * either is not a version we recognise.
 *
 * A naive numeric triple compare is correct here rather than lazy:
 * `tests/version.test.mjs` asserts that `package.json`'s version always matches
 * `^\d+\.\d+\.\d+$`, and semantic-release only ever produces that shape. Anything
 * else — a prerelease tag, a git sha, `undefined` — is `null` rather than a
 * guess, so a caller reports "unknown" instead of a confident wrong answer.
 */
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? '') ? v.split('.').map(Number) : null);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;

  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
