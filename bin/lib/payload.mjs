/**
 * Installing the workflow into a project.
 *
 * Modelled on BMAD's per-project install: a payload directory the installer
 * owns (`_youtrack/`), an adapter layer it generates (`.claude/skills/yt-*`),
 * and a manifest recording what was written and with what content hash.
 *
 * The manifest is the whole point. A vendored copy inside someone's repo goes
 * stale silently, and re-running the installer would otherwise clobber any
 * local edit without saying so. Hashing on the way in means an update can tell
 * "unchanged since we wrote it" (safe to overwrite) from "someone edited this"
 * (report it, leave it alone unless forced).
 *
 * Nothing written here has dependencies: the payload must run in a project with
 * no package.json at all.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Where the payload lands, relative to the project root. Fixed, so the skills need no templating. */
export const PAYLOAD_DIR = '_youtrack';
export const MANIFEST_PATH = join(PAYLOAD_DIR, '_config', 'manifest.json');
const SKILLS_DIR = join('.claude', 'skills');
const SETTINGS_PATH = join('.claude', 'settings.json');

/** Directories copied verbatim from the distribution into `_youtrack/`. */
const PAYLOAD_SOURCES = ['lib', 'scripts', 'hooks'];

const HOOK_COMMAND = `bash "$CLAUDE_PROJECT_DIR/${PAYLOAD_DIR}/hooks/check-commit-ticket.sh"`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Every file under `dir`, as paths relative to `base`, sorted for a stable manifest. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

/** Read a JSON file, or return `fallback` if it is missing or unparseable. */
function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readManifest(projectDir) {
  return readJson(join(projectDir, MANIFEST_PATH));
}

/**
 * Plan the file set this install would write: `{ relPath -> absolute source }`.
 * Paths are relative to the project root.
 */
export function planFiles(sourceRoot) {
  const files = new Map();

  for (const dir of PAYLOAD_SOURCES) {
    const from = join(sourceRoot, dir);
    if (!existsSync(from)) continue;
    for (const rel of walk(from)) {
      files.set(join(PAYLOAD_DIR, dir, rel), join(from, rel));
    }
  }

  // Skills are the adapter layer: copied out of the payload tree into the
  // place Claude Code actually reads them from.
  const skillsSrc = join(sourceRoot, 'skills');
  if (existsSync(skillsSrc)) {
    for (const entry of readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = join(skillsSrc, entry.name);
      for (const rel of walk(from)) {
        files.set(join(SKILLS_DIR, entry.name, rel), join(from, rel));
      }
    }
  }

  return files;
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
 * Add the commit-message hook to the project's settings, preserving anything
 * already there.
 *
 * Users have their own hooks; an install that overwrote `settings.json` would
 * silently delete them. Matching on the command string also makes a re-run a
 * no-op rather than appending a duplicate entry.
 *
 * @returns {{settings: object, added: boolean}}
 */
export function mergeHookIntoSettings(settings) {
  const next = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  next.hooks ??= {};
  const preToolUse = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];

  const already = preToolUse.some((entry) =>
    (entry?.hooks ?? []).some((h) => h?.command === HOOK_COMMAND),
  );
  if (already) {
    next.hooks.PreToolUse = preToolUse;
    return { settings: next, added: false };
  }

  next.hooks.PreToolUse = [
    ...preToolUse,
    { matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_COMMAND }] },
  ];
  return { settings: next, added: true };
}

/**
 * Install (or update) the workflow in `projectDir`.
 *
 * @param {object} opts
 * @param {string} opts.sourceRoot   the distribution checkout to copy from
 * @param {string} opts.projectDir   the project to install into
 * @param {string} opts.version      recorded in the manifest
 * @param {boolean} [opts.force]     overwrite locally-modified files
 * @param {boolean} [opts.dryRun]    plan only, write nothing
 * @returns {{written: string[], skipped: string[], removed: string[], hookAdded: boolean, isUpdate: boolean}}
 */
export function installPayload({ sourceRoot, projectDir, version, force = false, dryRun = false }) {
  const previous = readManifest(projectDir);
  const isUpdate = Boolean(previous);
  const drift = isUpdate ? detectDrift(projectDir, previous) : { modified: [] };
  const protectedPaths = new Set(force ? [] : drift.modified);

  const planned = planFiles(sourceRoot);
  const written = [];
  const skipped = [];
  const manifestFiles = [];

  for (const [rel, src] of planned) {
    const dest = join(projectDir, rel);
    const content = readFileSync(src);
    const hash = sha256(content);

    if (protectedPaths.has(rel)) {
      skipped.push(rel);
      // Keep the *previous* hash so the file stays flagged as modified on the
      // next run too, rather than silently becoming the new baseline.
      const prior = previous.files.find((f) => f.path === rel);
      manifestFiles.push({ path: rel, sha256: prior?.sha256 ?? hash });
      continue;
    }

    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      // Carry the executable bit across: the commit hook is run as a script.
      if (statSync(src).mode & 0o111) chmodSync(dest, 0o755);
    }
    written.push(rel);
    manifestFiles.push({ path: rel, sha256: hash });
  }

  // Files this version no longer ships, that the last one did.
  const removed = [];
  for (const entry of previous?.files ?? []) {
    if (planned.has(entry.path)) continue;
    if (protectedPaths.has(entry.path)) continue;
    const abs = join(projectDir, entry.path);
    if (!existsSync(abs)) continue;
    if (!dryRun) rmSync(abs, { force: true });
    removed.push(entry.path);
  }

  // Settings merge.
  const settingsAbs = join(projectDir, SETTINGS_PATH);
  const { settings, added: hookAdded } = mergeHookIntoSettings(readJson(settingsAbs, {}));
  if (!dryRun && hookAdded) {
    mkdirSync(dirname(settingsAbs), { recursive: true });
    writeFileSync(settingsAbs, `${JSON.stringify(settings, null, 2)}\n`);
  }

  if (!dryRun) {
    const now = new Date().toISOString();
    const manifest = {
      installation: {
        version,
        installDate: previous?.installation?.installDate ?? now,
        lastUpdated: now,
      },
      payloadDir: PAYLOAD_DIR,
      skills: [...planned.keys()]
        .filter((p) => p.startsWith(`${SKILLS_DIR}${sep}`) && p.endsWith('SKILL.md'))
        .map((p) => p.split(sep)[2]),
      files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    };
    const manifestAbs = join(projectDir, MANIFEST_PATH);
    mkdirSync(dirname(manifestAbs), { recursive: true });
    writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { written, skipped, removed, hookAdded, isUpdate, modified: drift.modified };
}
