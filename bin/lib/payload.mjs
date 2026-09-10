/**
 * Installing the workflow into a project.
 *
 * The shape: a payload directory the installer owns (`_dev-workflow/`), an adapter
 * layer it generates (`.claude/skills/dev-*`, plus one subagent definition per
 * file under `.claude/agents/dev-*.md`), and a manifest recording what was
 * written and with what content hash.
 *
 * The manifest is the whole point. A vendored copy inside someone's repo goes
 * stale silently, and re-running the installer would otherwise clobber any
 * local edit without saying so. Hashing on the way in means an update can tell
 * "unchanged since we wrote it" (safe to overwrite) from "someone edited this"
 * (report it, leave it alone unless forced).
 *
 * **We write only inside our own three roots.** A project is shared ground: other
 * tools install their own payloads and their own skills alongside ours, and a
 * `.claude/` directory in particular is common property. `isOwnedPath` is the
 * hard boundary — every write and, more importantly, every *delete* is filtered
 * through it, so a wrong or hand-edited manifest still cannot reach a file that
 * is not ours. `.claude/settings.json` is the one genuinely shared file, and it
 * is merged, never rewritten. A **global** install adds exactly one root more,
 * off the project: the runtime under `$HOME/` + `GLOBAL_PAYLOAD_DIR`, recorded in
 * a manifest of its own.
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
import {
  AGENTS_DIR,
  GLOBAL_PAYLOAD_DIR,
  INSTALL_MODES,
  MANIFEST_PATH,
  PAYLOAD_DIR,
  SKILLS_DIR,
  detectDrift,
  isGeneratedPath,
  readJson,
  readManifest,
  resolveInstallRoots,
  sha256,
} from '../../lib/manifest.mjs';

/**
 * The roots, re-exported rather than restated.
 *
 * `SKILLS_DIR` and `AGENTS_DIR` (the third root — #91, ADR 0003: one Markdown
 * file per agent, `dev-<name>.md`, under the same `dev-` prefix the skills
 * claim) used to be defined here, because only the installer needed to know
 * them. The installed payload has to answer the same question now —
 * `resolveInstallRoots` reports every root an install resolved to — so they
 * moved beside `PAYLOAD_DIR`, where one file decides all of them.
 * `tools/check-payload.mjs` imports them from here, and still may.
 */
export { AGENTS_DIR, MANIFEST_PATH, PAYLOAD_DIR, SKILLS_DIR, detectDrift, isGeneratedPath, readManifest };
const SETTINGS_PATH = join('.claude', 'settings.json');

/** Directories copied verbatim from the distribution into `_dev-workflow/`. */
export const PAYLOAD_SOURCES = ['lib', 'scripts', 'hooks'];

export const HOOK_COMMAND = `bash "$CLAUDE_PROJECT_DIR/${PAYLOAD_DIR}/hooks/check-commit-ticket.sh"`;

export const ADR_HOOK_COMMAND = `bash "$CLAUDE_PROJECT_DIR/${PAYLOAD_DIR}/hooks/check-adr-immutable.sh"`;

/**
 * Where a Node hook runs from, per install mode, as the prefix its command expands.
 *
 * The bash guards run from the project in every mode — a fresh clone has to
 * enforce — but the Node hooks import `../lib/…` and so run from wherever the
 * runtime went. `$HOME` rather than the resolved path: `.claude/settings.json`
 * is committed, and one developer's home directory in it would be a hook no one
 * else can run.
 */
const NODE_HOOK_ROOTS = {
  local: `$CLAUDE_PROJECT_DIR/${PAYLOAD_DIR}`,
  global: `$HOME/${GLOBAL_PAYLOAD_DIR}`,
};

function nodeHookCommand(mode, file) {
  if (!Object.hasOwn(NODE_HOOK_ROOTS, mode)) {
    throw new Error(`unknown install mode "${mode}" — expected ${INSTALL_MODES.join(' or ')}`);
  }
  return `node "${NODE_HOOK_ROOTS[mode]}/hooks/${file}"`;
}

/**
 * The session greeting, as a local install registers it. Node rather than
 * bash, and the only kind of hook that is: it needs a portable timeout, and
 * `timeout(1)` is not on a stock macOS. The hook's own header carries the full
 * reasoning.
 */
export const SESSION_HOOK_COMMAND = nodeHookCommand('local', 'session-standup.mjs');
/** The version notice, on the same event: its own entry so its own switch (hooks.updateCheck) can turn it off alone. */
export const UPDATE_HOOK_COMMAND = nodeHookCommand('local', 'session-updatecheck.mjs');

/**
 * Every hook we register: the event it fires on, the tool it matches, and the
 * command that runs.
 *
 * A list rather than hardcoded entries: the merge below is the only thing that
 * makes a hook actually apply, so a fourth hook must be one line here rather
 * than a second copy of the merge. `event` joined the shape when the session
 * greeting arrived — until then every hook was a `PreToolUse` one and the merge
 * could assume it, which is exactly the assumption a list exists to avoid.
 *
 * The matchers differ on purpose: the commit guard has to see every Bash call,
 * the ADR guard only file writes, and giving the latter a Bash matcher would
 * put it on the hot path for no gain. `SessionStart` takes no matcher at all —
 * it does not guard a tool — and an empty string is how that is spelled.
 */
export function shippedHooks(mode = 'local') {
  // `spellings` is every command this hook has in any mode. The guards have one;
  // the greetings have one per payload root, which is what lets the merge
  // recognise its own entry after a mode switch.
  const guard = (matcher, command) => ({ event: 'PreToolUse', matcher, command, spellings: [command] });
  const greeting = (file) => ({
    event: 'SessionStart',
    matcher: '',
    command: nodeHookCommand(mode, file),
    spellings: INSTALL_MODES.map((m) => nodeHookCommand(m, file)),
  });
  return [
    guard('Bash', HOOK_COMMAND),
    guard('Edit|Write', ADR_HOOK_COMMAND),
    greeting('session-standup.mjs'),
    greeting('session-updatecheck.mjs'),
  ];
}

/** What a local install registers. */
export const SHIPPED_HOOKS = shippedHooks('local');

/** The skill-name prefix we claim. Anything else in .claude/skills/ is someone else's. */
export const SKILL_PREFIX = 'dev-';

/** The same prefix, on agent files. One namespace for everything of ours a project can see. */
export const AGENT_PREFIX = SKILL_PREFIX;

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
 *
 * `root` names what `rel` is relative to. `project` is the three roots above.
 * `machine` is the global install's runtime root, `GLOBAL_PAYLOAD_DIR` under
 * `$HOME` (spelled once, in lib/manifest.mjs). That root is ours whole, so a
 * path under it is owned exactly when the same path under `_dev-workflow/`
 * would be, by the same traversal rules. Any other root owns nothing: a typo
 * in a caller must not widen the boundary.
 *
 * An option rather than a positional argument, because this is passed straight
 * to array methods (`paths.some(isOwnedPath)`) that hand over an index second.
 */
export function isOwnedPath(rel, { root = 'project' } = {}) {
  if (typeof rel !== 'string' || rel.length === 0) return false;

  const parts = rel.split(/[/\\]/);
  if (parts.includes('..') || parts.includes('') || rel.startsWith('/')) return false;

  if (root === 'machine') return isOwnedPath(join(PAYLOAD_DIR, rel));
  if (root !== 'project') return false;

  if (parts[0] === PAYLOAD_DIR) return parts.length > 1;

  if (parts[0] === '.claude' && parts[1] === 'skills') {
    return parts.length > 3 && parts[2].startsWith(SKILL_PREFIX);
  }

  // An agent is exactly one file, `.claude/agents/dev-<name>.md`: not a
  // directory, not any other extension, not the bare prefix.
  if (parts[0] === '.claude' && parts[1] === 'agents') {
    return parts.length === 3 && /^dev-[^/]+\.md$/.test(parts[2]) && parts[2] !== `${AGENT_PREFIX}.md`;
  }

  return false;
}

/**
 * Replace a file atomically: write a sibling temporary, then rename over it.
 *
 * Every write the installer makes goes through this — the payload, the manifest,
 * and `.claude/settings.json`, the one file we share with the user's own hooks.
 * A same-directory rename is atomic, so an interrupted install can never leave
 * a file half-written; for the settings file the alternative is a project whose
 * every Bash tool call fires a hook parsed out of truncated JSON.
 *
 * It is the default for `installPayload`'s injected `writeFile`, which is what
 * lets a test make the fourth write fail and check what the journal restores.
 */
function writeAtomically(absPath, body) {
  const tmp = `${absPath}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, absPath);
  } catch (err) {
    // A writer cleans up after itself: the journal restores files, it does not
    // know which temporary a given writer leaves behind.
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * What an install undoes when it fails partway.
 *
 * The manifest is written last, which is the right order for a crash — except
 * that the next run then compares the files a newer version half-wrote against
 * the hashes the older manifest records, reads them as the user's edits, and
 * protects them: the update is stuck until `--force`. So every write and every
 * removal first records what was there, and a failure puts all of it back, in
 * reverse, before the error reaches the caller. The old manifest was never
 * touched, so afterwards it is true again.
 *
 * In memory, not a backup directory: the payload is a few dozen small files,
 * it is meant to be committed, and git is the backup for everything else.
 */
function makeJournal() {
  const entries = [];
  const dirs = [];
  return {
    /** Create `dir` and its parents, remembering the first one that did not exist. */
    mkdir(dir) {
      const created = mkdirSync(dir, { recursive: true });
      if (created) dirs.push(created);
    },
    /** Call before the first write to, or removal of, `abs`. */
    remember(abs) {
      const present = existsSync(abs);
      entries.push({
        abs,
        previous: present ? readFileSync(abs) : null,
        mode: present ? statSync(abs).mode : null,
      });
    },
    /** Put every remembered path back as it was, then drop the directories this run created. */
    undo() {
      for (const { abs, previous, mode } of entries.reverse()) {
        if (previous === null) {
          rmSync(abs, { force: true });
        } else {
          writeFileSync(abs, previous);
          chmodSync(abs, mode);
        }
      }
      // Each was absent before this run, so everything under it is this run's.
      for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
    },
  };
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

  // Agents are the other adapter layer: one file each, out of `agents/` and
  // into the directory Claude Code reads subagent definitions from.
  const agentsSrc = join(sourceRoot, 'agents');
  if (existsSync(agentsSrc)) {
    for (const entry of readdirSync(agentsSrc, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      files.set(join(AGENTS_DIR, entry.name), join(agentsSrc, entry.name));
    }
  }

  return files;
}

/**
 * Does a payload file — relative to the payload root — go to the machine in a
 * global install?
 *
 * `lib/` and `scripts/` are the runtime. A Node hook goes with them because it
 * imports `../lib/…` relatively and cannot resolve it across roots. Everything
 * else under `hooks/` — the bash guards — stays in the project: a guard that is
 * not there exits 127, neither allow nor block, so enforcement would vanish from
 * a fresh clone without a word.
 */
function travelsWithRuntime(payloadRel) {
  return payloadRel.split(sep)[0] !== 'hooks' || payloadRel.endsWith('.mjs');
}

/**
 * The same plan, split the way a global install writes it: `{ machine, project }`.
 *
 * `machine` paths are relative to the payload root (`lib/config.mjs`); `project`
 * paths to the project, exactly as `planFiles` spells them. Derived from
 * `planFiles` rather than walked again, so the two can never disagree about what
 * ships — only about where it lands.
 */
export function planFileSets(sourceRoot) {
  const machine = new Map();
  const project = new Map();
  const prefix = `${PAYLOAD_DIR}${sep}`;

  for (const [rel, src] of planFiles(sourceRoot)) {
    const payloadRel = rel.startsWith(prefix) ? rel.slice(prefix.length) : null;
    if (payloadRel !== null && travelsWithRuntime(payloadRel)) machine.set(payloadRel, src);
    else project.set(rel, src);
  }

  return { machine, project };
}

/**
 * Add our hooks to the project's settings, preserving anything already there.
 *
 * Users have their own hooks; an install that overwrote `settings.json` would
 * silently delete them. Matching on the command string also makes a re-run a
 * no-op rather than appending a duplicate entry — and it is matched per hook,
 * so a project installed before a hook existed gains only the missing one and
 * keeps whatever the user did to the entry for the others.
 *
 * The match is per command across that command's own event, not across the file:
 * two hooks may legitimately share a command string on different events, and a
 * global search would then install only the first of them.
 *
 * **A mode switch rewrites, it does not append.** The greetings run from the
 * mode's payload root, so their command differs between modes while the
 * guards' does not. An entry holding another mode's spelling of one of our
 * hooks is rewritten where it stands — or dropped, when the current spelling is
 * already registered — so a switch never leaves a hook pointing at the root it
 * left. Only an exact spelling of ours is recognised: a lookalike is the user's.
 *
 * @param {object} settings
 * @param {{mode?: string}} [opts]
 * @returns {{settings: object, added: boolean, addedCommands: string[], changed: boolean}}
 *   `added` when a hook was registered that was not there at all; `changed`
 *   when the file needs writing, which a rewrite alone also makes true.
 */
export function mergeHookIntoSettings(settings, { mode = 'local' } = {}) {
  const next = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  next.hooks ??= {};

  const holds = (entry, commands) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => commands.has(h?.command));

  const addedCommands = [];
  let rewritten = false;
  for (const { event, matcher, command, spellings } of shippedHooks(mode)) {
    // A settings file may carry anything at all under an event key — this has
    // to survive a hand-edit that left a string or a null there.
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];

    const stale = new Set(spellings.filter((s) => s !== command));
    let present = existing.some((entry) => holds(entry, new Set([command])));

    const kept = [];
    for (const entry of existing) {
      if (!holds(entry, stale)) {
        kept.push(entry);
        continue;
      }
      const hooks = [];
      for (const hook of entry.hooks) {
        if (!stale.has(hook?.command)) hooks.push(hook);
        else if (!present) {
          hooks.push({ ...hook, command });
          present = true;
        }
      }
      rewritten = true;
      // An entry that held nothing but a stale copy goes with it.
      if (hooks.length > 0) kept.push({ ...entry, hooks });
    }

    if (present) {
      next.hooks[event] = kept;
      continue;
    }

    // An empty matcher is omitted rather than written as "": SessionStart
    // entries take no matcher, and an empty one is not the same as none.
    const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] };
    next.hooks[event] = [...kept, entry];
    addedCommands.push(command);
  }

  const added = addedCommands.length > 0;
  return { settings: next, added, addedCommands, changed: added || rewritten };
}

/**
 * The roots one install writes into, each with its own plan and its own manifest.
 *
 * Local is one target, the project, holding everything. Global is two: the
 * machine root with the runtime, and the project with the skills, the agents
 * and the guards. Each records only what was written into it, so each can be
 * updated, drift-checked and cleaned against its own manifest.
 */
function planTargets({ sourceRoot, projectDir, mode, env }) {
  const roots = resolveInstallRoots({ projectDir, mode, env });
  const project = { root: 'project', dir: projectDir, manifestAbs: join(projectDir, MANIFEST_PATH), payloadDir: PAYLOAD_DIR };

  if (roots.payloadRoot === join(roots.projectRoot, PAYLOAD_DIR)) {
    return [{ ...project, planned: planFiles(sourceRoot) }];
  }

  const sets = planFileSets(sourceRoot);
  return [
    { root: 'machine', dir: roots.payloadRoot, manifestAbs: roots.payloadManifest, payloadDir: GLOBAL_PAYLOAD_DIR, planned: sets.machine },
    { ...project, planned: sets.project },
  ];
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
 * @param {string} [opts.mode]       `local` (everything in the project) or `global` (the runtime on the machine)
 * @param {NodeJS.ProcessEnv} [opts.env]  where `$HOME` is read from in global mode
 * @returns {{written: string[], skipped: string[], removed: string[], hookAdded: boolean, addedCommands: string[], isUpdate: boolean}}
 *   Project files are reported project-relative; machine files by absolute path, so the two cannot be confused.
 */
export function installPayload({
  sourceRoot,
  projectDir,
  version,
  force = false,
  dryRun = false,
  writeFile = writeAtomically,
  mode = 'local',
  env = process.env,
}) {
  const targets = planTargets({ sourceRoot, projectDir, mode, env });
  const shown = (target, rel) => (target.root === 'machine' ? join(target.dir, rel) : rel);

  for (const target of targets) {
    target.previous = readJson(target.manifestAbs);
    target.drift = target.previous ? detectDrift(target.dir, target.previous) : { modified: [] };
    target.protectedPaths = new Set(force ? [] : target.drift.modified);
    target.manifestFiles = [];
  }
  const isUpdate = Boolean(targets.find((t) => t.root === 'project').previous);

  // A planned path outside our roots means the distribution itself is wrong —
  // a misnamed skill directory, say. Fail loudly rather than writing into
  // someone else's territory, and before the first write to any root.
  for (const { root, dir, planned } of targets) {
    for (const rel of planned.keys()) {
      if (isOwnedPath(rel, { root })) continue;
      throw new Error(
        root === 'machine'
          ? `refusing to install: ${rel} is outside the machine payload root ${dir}`
          : `refusing to install: ${rel} is outside ${PAYLOAD_DIR}/, .claude/skills/${SKILL_PREFIX}* and .claude/agents/${AGENT_PREFIX}*.md`,
      );
    }
  }

  const written = [];
  const skipped = [];
  const removed = [];
  let hookAdded = false;
  let addedCommands = [];

  // From the first write to the manifest, one journal. A throw anywhere in
  // between restores everything and rethrows; a restore that itself fails is
  // reported alongside the original error rather than in place of it.
  const journal = makeJournal();
  try {
    for (const target of targets) {
      for (const [rel, src] of target.planned) {
        const dest = join(target.dir, rel);
        const content = readFileSync(src);
        const hash = sha256(content);

        if (target.protectedPaths.has(rel)) {
          skipped.push(shown(target, rel));
          // Keep the *previous* hash so the file stays flagged as modified on the
          // next run too, rather than silently becoming the new baseline.
          const prior = target.previous.files.find((f) => f.path === rel);
          target.manifestFiles.push({ path: rel, sha256: prior?.sha256 ?? hash });
          continue;
        }

        if (!dryRun) {
          journal.mkdir(dirname(dest));
          journal.remember(dest);
          writeFile(dest, content);
          // Carry the executable bit across: the commit hook is run as a script.
          if (statSync(src).mode & 0o111) chmodSync(dest, 0o755);
        }
        written.push(shown(target, rel));
        target.manifestFiles.push({ path: rel, sha256: hash });
      }
    }

    // Files this version no longer ships, that the last one did.
    //
    // This is the only place the installer deletes anything, so it is where a bad
    // manifest would do real damage. Ownership is re-checked here rather than
    // trusted from the manifest: the file on disk was read from the project, not
    // written by us, and it may have been edited by hand. Each root is cleaned
    // against its own manifest and its own boundary only.
    for (const target of targets) {
      for (const entry of target.previous?.files ?? []) {
        if (target.planned.has(entry.path)) continue;
        if (target.protectedPaths.has(entry.path)) continue;
        if (!isOwnedPath(entry.path, { root: target.root })) continue;
        if (isGeneratedPath(entry.path)) continue;
        const abs = join(target.dir, entry.path);
        if (!existsSync(abs)) continue;
        if (!dryRun) {
          journal.remember(abs);
          rmSync(abs, { force: true });
        }
        removed.push(shown(target, entry.path));
      }
    }

    // Settings merge. Written atomically because this file is shared with the
    // user's own hooks: a torn write here breaks every Bash tool call in the
    // project, not just ours.
    const settingsAbs = join(projectDir, SETTINGS_PATH);
    const merged = mergeHookIntoSettings(readJson(settingsAbs, {}), { mode });
    hookAdded = merged.added;
    addedCommands = merged.addedCommands;
    // A mode switch rewrites entries without adding any, and still has to land.
    if (!dryRun && merged.changed) {
      journal.mkdir(dirname(settingsAbs));
      journal.remember(settingsAbs);
      writeFile(settingsAbs, `${JSON.stringify(merged.settings, null, 2)}\n`);
    }

    if (!dryRun) {
      const now = new Date().toISOString();
      for (const target of targets) {
        const manifest = {
          installation: {
            version,
            installDate: target.previous?.installation?.installDate ?? now,
            lastUpdated: now,
          },
          payloadDir: target.payloadDir,
          skills: [...target.planned.keys()]
            .filter((p) => p.startsWith(`${SKILLS_DIR}${sep}`) && p.endsWith("SKILL.md"))
            .map((p) => p.split(sep)[2]),
          files: target.manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
        };
        journal.mkdir(dirname(target.manifestAbs));
        journal.remember(target.manifestAbs);
        writeFile(target.manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }
  } catch (err) {
    try {
      journal.undo();
    } catch (undoErr) {
      err.message += `\n(restoring the previous files also failed: ${undoErr.message})`;
    }
    throw err;
  }

  const modified = targets.flatMap((target) => target.drift.modified.map((rel) => shown(target, rel)));
  return { written, skipped, removed, hookAdded, addedCommands, isUpdate, modified };
}
