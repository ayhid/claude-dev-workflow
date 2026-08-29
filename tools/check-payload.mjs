#!/usr/bin/env node
/**
 * Is the installed copy still the source it was generated from?
 *
 *   node tools/check-payload.mjs             report drift, exit non-zero if any
 *
 * **Repo-local development tooling. Not shipped** — `package.json#files` does
 * not list `tools/`, same as `tools/profile.mjs`, and the comparison would be
 * meaningless in a consumer's project anyway: a consumer has no `lib/` source
 * sitting beside its payload.
 *
 * ## Why this exists
 *
 * This repo is one of its own consumers. `_dev-workflow/` and
 * `.claude/skills/dev-*` are an installed copy produced from `lib/`, `scripts/`,
 * `hooks/` and `skills/` at the root — and **the copy is what runs**:
 * `.claude/settings.json` registers `_dev-workflow/hooks/check-commit-ticket.sh`,
 * not the source-tree one. Keeping the two in step was entirely manual, so a
 * stale copy meant the hook enforced here was not the hook that ships, and the
 * only signal was remembering to look at `git diff _dev-workflow/`.
 *
 * `dev.mjs version` does not answer this. It compares the installed tree against
 * the manifest's own recorded hashes — which catches a hand-edited copy — and
 * against the published npm version. Neither notices that the source next door
 * has moved on.
 *
 * ## The file set is not ours to decide
 *
 * Which files ship and where they land is `planFiles` in `bin/lib/payload.mjs`,
 * and this reads it rather than re-deriving it. A second copy of that mapping is
 * exactly the drift this repo refuses everywhere else — it would go stale the
 * first time the installer learned to copy a new directory, and go stale
 * silently, reporting a clean tree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MANIFEST_PATH, PAYLOAD_DIR, isOwnedPath, planFiles, readManifest } from '../bin/lib/payload.mjs';

/**
 * Unplanned paths that are nonetheless legitimate.
 *
 * `_config/` is what the installer writes *about* the install — the manifest and
 * the update-check stamp — and `artifacts/` is where the payload's own commands
 * write at runtime, `dev.mjs ingest` above all. Neither was ever copied from a
 * source file, so neither can be compared against one; reporting them would make
 * every clean checkout red.
 *
 * Spelled from `PAYLOAD_DIR` rather than as literals, so the payload directory
 * is still named in exactly one place.
 */
const UNPLANNED_BUT_OURS = [join(PAYLOAD_DIR, '_config'), join(PAYLOAD_DIR, 'artifacts')];

/** Every file under `dir`, relative to `base`. */
function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

/**
 * The directories an install owns, **derived** from what it plans to write.
 *
 * The orphan sweep needs somewhere to look, and the obvious way to get it is to
 * write `_dev-workflow` and `.claude/skills/dev-*` down here. That would be the
 * second copy of the destination mapping this whole file exists to avoid.
 *
 * So instead: walk each planned path's prefixes and stop at the shortest one
 * `isOwnedPath` already accepts a child of. `_dev-workflow/lib/x.mjs` yields
 * `_dev-workflow`; `.claude/skills/dev-task/SKILL.md` yields
 * `.claude/skills/dev-task`, because `isOwnedPath` rejects `.claude` and
 * `.claude/skills` and accepts only the third level down. The boundary stays
 * defined in exactly one place, and it is the same predicate the installer
 * filters its own writes and deletes through.
 */
export function ownedRoots(planned) {
  const roots = new Set();

  for (const rel of planned.keys()) {
    const parts = rel.split(sep);
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(sep);
      if (isOwnedPath(join(prefix, parts[i]))) {
        roots.add(prefix);
        break;
      }
    }
  }

  return [...roots].sort();
}

/**
 * The roots to sweep: the ones an install plans, plus the ones already on disk.
 *
 * `ownedRoots` can only see what is still planned, and that is exactly blind to
 * the case worth catching. Delete `skills/dev-old/` from the source tree and no
 * planned path yields `.claude/skills/dev-old` any more, so the installed skill
 * is never looked at — while `isOwnedPath` still calls every file in it ours and
 * the installer's delete pass would still remove them. `_dev-workflow` does not
 * have this problem because it is one root that never stops being planned; a
 * skill directory is a root per skill.
 *
 * The extra roots are *discovered*, not listed: look beside each derived root
 * and take any sibling directory that actually holds a file `isOwnedPath`
 * accepts. The boundary is still the one predicate, and `.claude/skills` is
 * still not written down here.
 */
function installedRoots(planned, projectDir) {
  const roots = new Set(ownedRoots(planned));

  for (const root of [...roots]) {
    const parent = dirname(root);
    // `_dev-workflow` sits at the project root, and sweeping every sibling of
    // *that* is the whole project — every other tool's payload included.
    if (parent === '.' || parent === '') continue;

    const absParent = join(projectDir, parent);
    if (!existsSync(absParent)) continue;

    for (const entry of readdirSync(absParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(parent, entry.name);
      if (roots.has(candidate)) continue;
      if (walk(join(projectDir, candidate), projectDir).some(isOwnedPath)) roots.add(candidate);
    }
  }

  return [...roots].sort();
}

/**
 * Compare the installed copy against the source it is generated from.
 *
 * `sourceRoot` and `projectDir` are the same directory for this repo — it
 * installs into itself — but they are separate arguments for the same reason
 * `installPayload` takes both: it is what lets a test drive this over a
 * temporary tree instead of over the checkout it is running in.
 *
 * @returns {{stale: string[], missing: string[], orphan: string[]}}
 */
export function checkPayload({ sourceRoot, projectDir = sourceRoot }) {
  const planned = planFiles(sourceRoot);

  const stale = [];
  const missing = [];

  for (const [rel, src] of planned) {
    const dest = join(projectDir, rel);
    if (!existsSync(dest)) {
      missing.push(rel);
      continue;
    }
    // Byte-for-byte. The installer copies verbatim, so anything short of
    // equality is drift — there is no formatting to normalise away.
    //
    // `existsSync` answers "something is there", not "a file is there". A
    // directory at a planned path throws EISDIR out of `readFileSync`, and a
    // stack trace is a poor answer from the one tool whose job is to name the
    // path. It is drift like anything else: not what the source says belongs
    // there. Asked as `isFile()` rather than by catching, so a genuine EACCES
    // still surfaces as itself instead of being relabelled as drift.
    if (!statSync(dest).isFile() || !readFileSync(dest).equals(readFileSync(src))) stale.push(rel);
  }

  // What is on disk under our roots but no longer planned — the set the
  // installer's delete pass would remove on the next run. Left alone it is a
  // file that ships to nobody and runs here, which is the same class of lie as
  // a stale one.
  const orphan = [];
  for (const root of installedRoots(planned, projectDir)) {
    const abs = join(projectDir, root);
    if (!existsSync(abs)) continue;
    for (const rel of walk(abs, projectDir)) {
      if (planned.has(rel)) continue;
      if (UNPLANNED_BUT_OURS.some((p) => rel === p || rel.startsWith(`${p}${sep}`))) continue;
      orphan.push(rel);
    }
  }

  return { stale: stale.sort(), missing: missing.sort(), orphan: orphan.sort() };
}

/**
 * What the manifest says this install is, against what the repo is now.
 *
 * These are **expected** to differ by one release, and that is structural rather
 * than a mistake: the payload is refreshed from a working tree, and
 * `@semantic-release/git` writes the version bump back to `package.json` only
 * after the push. So the copy is always stamped one release behind the repo that
 * produced it.
 *
 * Reported, therefore, and never counted as drift. A note that could fail a
 * build would fail every build, and a check that is red by design gets switched
 * off within a week.
 */
export function versionNote({ projectDir }) {
  const installed = readManifest(projectDir)?.installation?.version ?? null;

  let declared = null;
  try {
    declared = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    declared = null;
  }

  if (!installed) return `version: no install manifest at ${MANIFEST_PATH} — nothing to compare`;
  if (!declared) return `version: manifest records ${installed}; package.json declares none`;
  if (installed === declared) return `version: manifest and package.json agree at ${installed}`;

  return (
    `version: manifest records ${installed}, package.json ${declared} — expected, and not an error. ` +
    'The payload is stamped from the working tree before the release writes the bump back.'
  );
}

/** The report, as lines. Sorted throughout: the same tree prints the same bytes. */
export function render({ stale, missing, orphan }, note, planned) {
  const lines = [];
  const rows = [
    ['stale', stale, 'the source moved on and the copy did not'],
    ['missing', missing, 'planned by the installer, not on disk'],
    ['orphan', orphan, 'no longer shipped; the next install would remove it'],
  ];

  const count = stale.length + missing.length + orphan.length;
  if (count === 0) {
    lines.push(`payload: ${planned} files, byte-identical to the source they were generated from`);
  } else {
    // Not "N of M planned files": an orphan is by definition not planned, so
    // counting it against the planned total would be a category error in the
    // one line most readers stop at.
    lines.push(`payload: ${count} problem${count === 1 ? '' : 's'} across ${planned} planned files`, '');
    for (const [label, paths, why] of rows) {
      if (paths.length === 0) continue;
      lines.push(`  ${label} — ${why}`);
      for (const p of paths) lines.push(`    ${p}`);
      lines.push('');
    }
    lines.push('Refresh the installed copy with:', '  npm run check:payload -- --refresh', '');
  }

  lines.push(note);
  return lines;
}

const drifted = ({ stale, missing, orphan }) => stale.length + missing.length + orphan.length;

/**
 * Bring the installed copy back in step by **running the installer**.
 *
 * Deliberately not by copying the planned files here. `isOwnedPath`, the write
 * plan and the delete pass are one implementation of the boundary deciding what
 * may be written and removed in a project, and they stay in `bin/lib/payload.mjs`.
 * A writer in this file would be a second copy of that rule — which is exactly
 * why `dev.mjs version --upgrade` spawns the installer rather than unpacking
 * anything itself.
 *
 * The installer is taken from `sourceRoot`, not from beside this file: the point
 * is to refresh the copy from the tree being checked.
 */
function refresh({ sourceRoot, projectDir, spawn }) {
  const installer = join(sourceRoot, 'bin', 'install.mjs');
  const { status } = spawn(process.execPath, [installer, '--update', '--dir', projectDir], {
    stdio: 'inherit',
  });
  return status === 0 ? null : `refresh: the installer exited ${status ?? 'without a status'}`;
}

/**
 * @param {string[]} argv
 * @param {{sourceRoot?: string, projectDir?: string, write?: (s: string) => void,
 *          spawn?: typeof spawnSync}} io
 * @returns {number} exit code — non-zero for content drift only
 */
export function main(argv = [], io = {}) {
  const sourceRoot = io.sourceRoot ?? process.cwd();
  const projectDir = io.projectDir ?? sourceRoot;
  const write = io.write ?? ((s) => process.stdout.write(s));
  const spawn = io.spawn ?? spawnSync;

  const planned = planFiles(sourceRoot).size;
  const notes = [];

  // Read-only unless asked. And when asked, the state reported is the one read
  // back *after* the write, never the one the write intended — the same rule the
  // tracker adapters follow, for the same reason.
  if (argv.includes('--refresh')) {
    const failure = refresh({ sourceRoot, projectDir, spawn });
    if (failure) notes.push(failure);
  }

  const result = checkPayload({ sourceRoot, projectDir });
  notes.push(versionNote({ projectDir }));

  write(`${render(result, notes.join('\n'), planned).join('\n')}\n`);

  return drifted(result) === 0 ? 0 : 1;
}

/**
 * Run only when this file *is* the command, and get the comparison right.
 *
 * Two things break the obvious `file://${process.argv[1]}` spelling, and both
 * break it the same silent way: the guard is false, `main` never runs, and the
 * process exits 0 having checked nothing. A guard that reports success when it
 * did not run is worse than one that throws — this is the check that fails the
 * build on drift, so a silent no-op is a green build over a stale payload.
 *
 *   - `import.meta.url` is percent-encoded and `process.argv[1]` is not, so any
 *     space or non-ASCII character in the checkout path defeats it.
 *   - `import.meta.url` is realpath-resolved and `process.argv[1]` is not, so a
 *     path through a symlink defeats it as well — on macOS `/tmp` is one.
 *
 * `realpathSync` then `pathToFileURL` answers both.
 *
 * `process.exitCode` rather than `process.exit`: `exit` tears the process down
 * without flushing, and stdout to a pipe is non-blocking, so a long enough
 * report is truncated at the pipe buffer. Setting the code lets Node drain and
 * leave on its own.
 */
function invokedDirectly(url) {
  const entry = process.argv[1];
  // No entry script at all — `node -e`, `--input-type=module`, a REPL. Nothing
  // is being run as a command, so this is not it.
  if (!entry) return false;
  try {
    return url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // `realpathSync` throws only for an entry that cannot be resolved, and the
    // script Node is currently executing always can — it just loaded it. So
    // this catch cannot swallow the real invocation, only an unresolvable one
    // that is by definition some other module.
    return false;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
