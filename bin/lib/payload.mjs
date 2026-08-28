/**
 * Installing the workflow into a project.
 *
 * The shape: a payload directory the installer owns (`_dev-workflow/`), an adapter
 * layer it generates (`.claude/skills/dev-*`), and a manifest recording what was
 * written and with what content hash.
 *
 * The manifest is the whole point. A vendored copy inside someone's repo goes
 * stale silently, and re-running the installer would otherwise clobber any
 * local edit without saying so. Hashing on the way in means an update can tell
 * "unchanged since we wrote it" (safe to overwrite) from "someone edited this"
 * (report it, leave it alone unless forced).
 *
 * **We write only inside our own two roots.** A project is shared ground: other
 * tools install their own payloads and their own skills alongside ours, and a
 * `.claude/` directory in particular is common property. `isOwnedPath` is the
 * hard boundary — every write and, more importantly, every *delete* is filtered
 * through it, so a wrong or hand-edited manifest still cannot reach a file that
 * is not ours. `.claude/settings.json` is the one genuinely shared file, and it
 * is merged, never rewritten.
 *
 * Nothing written here has dependencies: the payload must run in a project with
 * no package.json at all.
 *
 * Reading the manifest back lives in `lib/manifest.mjs`, which ships, because the
 * installed payload reports its own version and drift from the same file. The
 * *writing* — `planFiles`, `isOwnedPath`, `installPayload` and the delete pass —
 * stays here and is never copied into a project, so the boundary has exactly one
 * implementation.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

// The manifest schema is understood in one place, and that place ships: the
// installed payload reads the same file back to report its own version and
// drift. See lib/manifest.mjs for why the ownership boundary does *not* move
// with it.
import { MANIFEST_PATH, PAYLOAD_DIR, detectDrift, readJson, readManifest, sha256 } from '../../lib/manifest.mjs';

export { MANIFEST_PATH, PAYLOAD_DIR, detectDrift, readManifest };

const SKILLS_DIR = join('.claude', 'skills');
const SETTINGS_PATH = join('.claude', 'settings.json');

/** Directories copied verbatim from the distribution into `_dev-workflow/`. */
const PAYLOAD_SOURCES = ['lib', 'scripts', 'hooks'];

export const HOOK_COMMAND = `bash "$CLAUDE_PROJECT_DIR/${PAYLOAD_DIR}/hooks/check-commit-ticket.sh"`;

export const ADR_HOOK_COMMAND = `bash "$CLAUDE_PROJECT_DIR/${PAYLOAD_DIR}/hooks/check-adr-immutable.sh"`;

/**
 * Every hook we register, and the tool each one guards.
 *
 * A list rather than two hardcoded entries: the merge below is the only thing
 * that makes a hook actually apply, so a third hook must be one line here
 * rather than a second copy of the merge. The matchers differ on purpose —
 * the commit guard has to see every Bash call, the ADR guard only file writes,
 * and giving the latter a Bash matcher would put it on the hot path for no gain.
 */
export const SHIPPED_HOOKS = [
  { matcher: 'Bash', command: HOOK_COMMAND },
  { matcher: 'Edit|Write', command: ADR_HOOK_COMMAND },
];

/** The skill-name prefix we claim. Anything else in .claude/skills/ is someone else's. */
export const SKILL_PREFIX = 'dev-';

/**
 * May the installer write to, or delete, this project-relative path?
 *
 * The only two answers are "inside `_dev-workflow/`" and "a `.claude/skills/dev-*`
 * directory". Everything else in the project belongs to someone else — another
 * tool's payload, another tool's skills, or the user's own files.
 *
 * Writes and deletes share one predicate on purpose. There is no second,
 * looser rule for deletion: whatever the installer is not allowed to create, it
 * is not allowed to remove either.
 *
 * Path traversal is rejected outright: a manifest entry of `../../etc/thing`
 * must never resolve outside the project.
 */
export function isOwnedPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;

  const parts = rel.split(/[/\\]/);
  if (parts.includes('..') || parts.includes('') || rel.startsWith('/')) return false;

  if (parts[0] === PAYLOAD_DIR) return parts.length > 1;

  if (parts[0] === '.claude' && parts[1] === 'skills') {
    return parts.length > 3 && parts[2].startsWith(SKILL_PREFIX);
  }

  return false;
}

/**
 * Replace a file atomically: write a sibling temporary, then rename over it.
 *
 * Used for `.claude/settings.json`, the one file we share with the user's own
 * hooks. A same-directory rename is atomic, so an interrupted install can never
 * leave that file half-written — the alternative is a project whose every Bash
 * tool call fires a hook parsed out of truncated JSON.
 */
function writeAtomically(absPath, body) {
  const tmp = `${absPath}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, absPath);
}

/** Every file under `dir`, as paths relative to `base`, sorted for a stable manifest. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
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
 * Add our PreToolUse hooks to the project's settings, preserving anything
 * already there.
 *
 * Users have their own hooks; an install that overwrote `settings.json` would
 * silently delete them. Matching on the command string also makes a re-run a
 * no-op rather than appending a duplicate entry — and it is matched per hook,
 * so a project installed before a hook existed gains only the missing one and
 * keeps whatever the user did to the entry for the other.
 *
 * @returns {{settings: object, added: boolean, addedCommands: string[]}}
 */
export function mergeHookIntoSettings(settings) {
  const next = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  next.hooks ??= {};
  let preToolUse = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];

  const addedCommands = [];
  for (const { matcher, command } of SHIPPED_HOOKS) {
    const already = preToolUse.some((entry) =>
      (entry?.hooks ?? []).some((h) => h?.command === command),
    );
    if (already) continue;
    preToolUse = [...preToolUse, { matcher, hooks: [{ type: 'command', command }] }];
    addedCommands.push(command);
  }

  next.hooks.PreToolUse = preToolUse;
  return { settings: next, added: addedCommands.length > 0, addedCommands };
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
 * @returns {{written: string[], skipped: string[], removed: string[], hookAdded: boolean, addedCommands: string[], isUpdate: boolean}}
 */
export function installPayload({ sourceRoot, projectDir, version, force = false, dryRun = false }) {
  const previous = readManifest(projectDir);
  const isUpdate = Boolean(previous);
  const drift = isUpdate ? detectDrift(projectDir, previous) : { modified: [] };
  const protectedPaths = new Set(force ? [] : drift.modified);

  const planned = planFiles(sourceRoot);

  // A planned path outside our roots means the distribution itself is wrong —
  // a misnamed skill directory, say. Fail loudly rather than writing into
  // someone else's territory.
  for (const rel of planned.keys()) {
    if (!isOwnedPath(rel)) {
      throw new Error(
        `refusing to install: ${rel} is outside ${PAYLOAD_DIR}/ and .claude/skills/${SKILL_PREFIX}*`,
      );
    }
  }

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
  //
  // This is the only place the installer deletes anything, so it is where a bad
  // manifest would do real damage. Ownership is re-checked here rather than
  // trusted from the manifest: the file on disk was read from the project, not
  // written by us, and it may have been edited by hand.
  const removed = [];
  for (const entry of previous?.files ?? []) {
    if (planned.has(entry.path)) continue;
    if (protectedPaths.has(entry.path)) continue;
    if (!isOwnedPath(entry.path)) continue;
    const abs = join(projectDir, entry.path);
    if (!existsSync(abs)) continue;
    if (!dryRun) rmSync(abs, { force: true });
    removed.push(entry.path);
  }

  // Settings merge. Written atomically because this file is shared with the
  // user's own hooks: a torn write here breaks every Bash tool call in the
  // project, not just ours.
  const settingsAbs = join(projectDir, SETTINGS_PATH);
  const { settings, added: hookAdded, addedCommands } = mergeHookIntoSettings(readJson(settingsAbs, {}));
  if (!dryRun && hookAdded) {
    mkdirSync(dirname(settingsAbs), { recursive: true });
    writeAtomically(settingsAbs, `${JSON.stringify(settings, null, 2)}\n`);
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
        .filter((p) => p.startsWith(`${SKILLS_DIR}${sep}`) && p.endsWith("SKILL.md"))
        .map((p) => p.split(sep)[2]),
      files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    };
    const manifestAbs = join(projectDir, MANIFEST_PATH);
    mkdirSync(dirname(manifestAbs), { recursive: true });
    writeAtomically(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { written, skipped, removed, hookAdded, addedCommands, isUpdate, modified: drift.modified };
}
