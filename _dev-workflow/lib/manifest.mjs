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
import { join, resolve } from 'node:path';

/** Where the payload lands under the project, in local mode. */
export const PAYLOAD_DIR = '_dev-workflow';
export const MANIFEST_PATH = join(PAYLOAD_DIR, '_config', 'manifest.json');

/**
 * Where a project's skills live, and where its subagent definitions live — one
 * file per agent, `dev-<name>.md` (ADR 0003).
 *
 * Here rather than in `bin/lib/payload.mjs`, which re-exports them: both roots
 * are now part of an *answer* the installed payload has to give as well, since
 * `resolveInstallRoots` below reports every root an install resolved to. Two
 * spellings of `.claude/skills` is the drift this module exists to prevent.
 */
export const SKILLS_DIR = join('.claude', 'skills');
export const AGENTS_DIR = join('.claude', 'agents');

/**
 * Where a **global** install keeps the runtime, relative to the user's home.
 *
 * Spelled here and nowhere else: `tests/installroots.test.mjs` sweeps `bin/`
 * and `lib/` for a second spelling — the literal path and the
 * `join('.claude', 'dev-workflow')` form both — and fails on one. A root that
 * two files decide independently is a root they eventually disagree about, and
 * the symptom is a `dev.mjs` the skills cannot find.
 *
 * One machine, one payload, however the binary arrived: brew, `npm -g` and
 * `npx …@latest` all write here.
 */
export const GLOBAL_PAYLOAD_DIR = '.claude/dev-workflow';

/** The two install modes, in the order the wizard offers them. */
export const INSTALL_MODES = ['local', 'global'];

/**
 * The placeholder the skill and agent *sources* carry where the path to
 * `dev.mjs` is spelled, and which the installer replaces with the mode's own
 * payload root on the way in.
 *
 * A constant rather than a literal in two files: the sources put it in and the
 * installer takes it out, so a typo on either side is a skill whose first
 * command names a path that does not exist. `{{…}}` because nothing in
 * Markdown, YAML frontmatter or a shell command line means anything by it.
 */
export const PAYLOAD_ROOT_TOKEN = '{{DEV_WORKFLOW_PAYLOAD_ROOT}}';

/**
 * Every root an install resolves to, for one mode.
 *
 * `local` returns the project-relative paths every install has always used.
 * `global` moves the **runtime alone** onto the machine: the skills, the agents
 * and the bash guards stay in the project, because a guard that is not there
 * exits 127 — neither 0 nor 2 — so enforcement would disappear silently from a
 * fresh clone rather than fail loudly.
 *
 * That split is why there are two manifests rather than one. Each root records
 * what was written into it; in local mode they are the same file, which is the
 * degenerate case of the same shape rather than a special case.
 *
 * `env` is a parameter rather than `process.env` because every test of this
 * needs `$HOME` pointed somewhere temporary, and a resolver that read the real
 * one could only be tested by mutating global state.
 *
 * @param {{projectDir: string, mode?: string, env?: NodeJS.ProcessEnv}} opts
 * @returns {{mode: string, projectRoot: string, payloadRoot: string, skillsRoot: string,
 *            agentsRoot: string, payloadManifest: string, projectManifest: string}}
 */
export function resolveInstallRoots({ projectDir, mode = 'local', env = {} } = {}) {
  if (typeof projectDir !== 'string' || projectDir === '') {
    throw new Error('resolveInstallRoots needs a projectDir');
  }
  if (!INSTALL_MODES.includes(mode)) {
    throw new Error(`unknown install mode "${mode}" — expected ${INSTALL_MODES.join(' or ')}`);
  }

  const projectRoot = resolve(projectDir);
  const projectManifest = join(projectRoot, MANIFEST_PATH);

  let payloadRoot = join(projectRoot, PAYLOAD_DIR);
  if (mode === 'global') {
    // Named, not inferred: a home-less environment resolving to `undefined/.claude`
    // would write a directory called "undefined" and report success.
    const home = env.HOME || env.USERPROFILE;
    if (!home) throw new Error('install.mode is global but neither HOME nor USERPROFILE is set');
    payloadRoot = join(home, GLOBAL_PAYLOAD_DIR);
  }

  return {
    mode,
    projectRoot,
    payloadRoot,
    skillsRoot: join(projectRoot, SKILLS_DIR),
    agentsRoot: join(projectRoot, AGENTS_DIR),
    payloadManifest: join(payloadRoot, '_config', 'manifest.json'),
    projectManifest,
  };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Is this path per-project generated data — a document ingest or a docs draft
 * wrote it — rather than something the installer shipped?
 *
 * `_dev-workflow/` holds both: the payload the installer copies in, and content
 * generated at runtime under `_dev-workflow/artifacts/`. Shared between the
 * write side (`bin/lib/payload.mjs`'s delete pass) and the read side
 * (`detectDrift` below): a hash-matching or drifted manifest entry for a
 * generated path must never be deleted, and must never be reported as installer
 * drift either — both rely on the same predicate rather than each trusting that
 * `planFiles` happens not to plan an artifacts path today.
 *
 * A literal `.` path segment (`_dev-workflow/./artifacts/x`) is normalized away
 * before the check, since a hand-edited manifest may carry one. A `..` or empty
 * segment is rejected outright rather than normalized: `detectDrift` calls this
 * with no `isOwnedPath` gate ahead of it, unlike the delete pass, so this must
 * reject malformed paths on its own rather than borrow that rejection from a
 * caller that may not be there.
 */
export function isGeneratedPath(rel) {
  if (typeof rel !== 'string') return false;
  const parts = rel.split(/[/\\]/).filter((p) => p !== '.');
  if (parts.includes('..') || parts.includes('') || rel.startsWith('/')) return false;
  return parts[0] === PAYLOAD_DIR && parts[1] === 'artifacts';
}

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
    if (isGeneratedPath(entry.path)) continue;
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
