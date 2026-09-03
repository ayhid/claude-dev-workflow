/**
 * The source-vs-copy check (repo-local dev tooling, not shipped).
 *
 * This repo is one of its own consumers: `_dev-workflow/` and
 * `.claude/skills/dev-*` are an installed copy of `lib/`, `scripts/`, `hooks/`
 * and `skills/`, and the copy is what actually runs. Keeping the two in step
 * was manual until this check existed.
 *
 * Everything here runs against a temporary tree built in `mkdtemp`. Asserting
 * against this repo's own installed copy would make the suite depend on
 * whether someone had refreshed it, which is the very thing under test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { checkPayload, main } from '../tools/check-payload.mjs';

/** Write `body` at `rel` under `root`, creating parents. */
function put(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/**
 * A miniature of this repo: the four payload source directories, plus the
 * installed copy the installer would have written from them.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'payload-check-'));

  const sources = [
    ['lib/thing.mjs', 'export const thing = 1;\n'],
    ['scripts/dev.mjs', '#!/usr/bin/env node\n'],
    ['hooks/guard.sh', '#!/usr/bin/env bash\n'],
  ];
  for (const [rel, body] of sources) {
    put(root, rel, body);
    put(root, join('_dev-workflow', rel), body);
  }

  put(root, 'skills/dev-thing/SKILL.md', '# dev-thing\n');
  put(root, '.claude/skills/dev-thing/SKILL.md', '# dev-thing\n');

  put(root, 'agents/dev-thing.md', '---\nname: dev-thing\n---\n# dev-thing\n');
  put(root, '.claude/agents/dev-thing.md', '---\nname: dev-thing\n---\n# dev-thing\n');

  return root;
}

test('AC3: a copy regenerated from the source reports no drift', () => {
  const root = fixture();
  assert.deepEqual(checkPayload({ sourceRoot: root }), { stale: [], missing: [], orphan: [] });
});

test('AC4: a source edited with the installed copy untouched is stale, by name', () => {
  const root = fixture();
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  const { stale, missing, orphan } = checkPayload({ sourceRoot: root });
  assert.deepEqual(stale, [join('_dev-workflow', 'lib', 'thing.mjs')]);
  assert.deepEqual(missing, []);
  assert.deepEqual(orphan, []);
});

test('AC5: a planned file absent from the installed tree is missing, by name', () => {
  const root = fixture();
  rmSync(join(root, '_dev-workflow', 'hooks', 'guard.sh'));

  const { stale, missing } = checkPayload({ sourceRoot: root });
  assert.deepEqual(missing, [join('_dev-workflow', 'hooks', 'guard.sh')]);
  assert.deepEqual(stale, []);
});

test('AC4/AC5: a skill is compared the same way as the payload', () => {
  // Skills land somewhere else entirely — `.claude/skills/`, not
  // `_dev-workflow/` — so a check that only walked the payload directory would
  // pass here while the skills the agent actually loads were stale.
  const root = fixture();
  put(root, 'skills/dev-thing/SKILL.md', '# dev-thing, rewritten\n');

  assert.deepEqual(checkPayload({ sourceRoot: root }).stale, [
    join('.claude', 'skills', 'dev-thing', 'SKILL.md'),
  ]);
});

test('AC6: an unplanned file under an owned root is an orphan', () => {
  const root = fixture();
  put(root, '_dev-workflow/lib/gone.mjs', 'export const gone = 1;\n');
  put(root, '.claude/skills/dev-thing/OLD.md', '# removed\n');

  const { orphan, stale, missing } = checkPayload({ sourceRoot: root });
  assert.deepEqual(orphan, [
    join('.claude', 'skills', 'dev-thing', 'OLD.md'),
    join('_dev-workflow', 'lib', 'gone.mjs'),
  ]);
  assert.deepEqual(stale, []);
  assert.deepEqual(missing, []);
});

test('the CLI still runs when its own path has a space or a symlink in it', () => {
  // The guard decides whether this file is the command being run, and the
  // obvious `file://${process.argv[1]}` spelling gets it wrong twice:
  // `import.meta.url` is percent-encoded and realpath-resolved, and
  // `process.argv[1]` is neither. Both mismatches fail the same silent way —
  // `main` never runs and the process exits 0 having checked nothing, which is
  // a green build over a stale payload. Exercised through a real spawn, since
  // importing `main` is precisely what does not go through the guard.
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '..');

  const box = mkdtempSync(join(tmpdir(), 'payload-cli-'));
  const awkward = join(box, 'a dir with spaces');
  mkdirSync(awkward);
  // A symlink to the checkout: relative imports still resolve through it, so
  // the only thing that changes is the path the CLI is invoked by.
  symlinkSync(repo, join(awkward, 'repo'), 'dir');

  const project = fixture();
  const cli = join(awkward, 'repo', 'tools', 'check-payload.mjs');
  const r = spawnSync(process.execPath, [cli], { cwd: project, encoding: 'utf8' });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /payload:/, 'the guard let main run and the report was printed');

  // Node has two spellings of "which file is this" and picks by flag: normally
  // `import.meta.url` is realpath-resolved, and under `--preserve-symlinks-main`
  // it keeps the symlink instead — so resolving the entry, the fix for the
  // default mode, is precisely what breaks this one. Both must run.
  const preserved = spawnSync(process.execPath, ['--preserve-symlinks-main', cli], {
    cwd: project,
    encoding: 'utf8',
  });

  assert.equal(preserved.status, 0, preserved.stderr);
  assert.match(preserved.stdout, /payload:/, 'the guard holds with --preserve-symlinks-main too');

  rmSync(box, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test('importing the module without an entry script does not throw', () => {
  // The entry guard resolves `process.argv[1]`, and there are contexts with no
  // entry script at all — `node -e`, `--input-type=module`, a REPL. Resolving
  // `undefined` throws ENOENT at import time, which would make the module
  // unloadable rather than merely not-the-command. Spawned, because the guard
  // is top-level code that a plain import from inside this suite runs with
  // `argv[1]` already set to the test file.
  const here = dirname(fileURLToPath(import.meta.url));
  const mod = pathToFileURL(join(here, '..', 'tools', 'check-payload.mjs')).href;

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(mod)});`], {
    encoding: 'utf8',
  });

  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ENOENT|undefined/);
});

test('a directory where a planned file belongs is drift, not a crash', () => {
  // `existsSync` says something is there, not that it is a file. Left to
  // `readFileSync` this threw EISDIR — a stack trace out of the one tool whose
  // job is to name the path that is wrong.
  const root = fixture();
  const planted = join(root, '_dev-workflow', 'lib', 'thing.mjs');
  rmSync(planted);
  mkdirSync(planted, { recursive: true });

  const { stale, missing, orphan } = checkPayload({ sourceRoot: root });
  assert.deepEqual(stale, [join('_dev-workflow', 'lib', 'thing.mjs')]);
  assert.deepEqual(missing, []);
  assert.deepEqual(orphan, []);

  rmSync(root, { recursive: true, force: true });
});

test('AC6: a skill removed from the source leaves its whole installed directory orphaned', () => {
  // The gap the derived roots had. `.claude/skills/dev-old` is a root only for
  // as long as `skills/dev-old/` is still planned, so deleting the source made
  // the installed copy invisible rather than reported — while `isOwnedPath`
  // still called it ours and the installer's delete pass would still remove it.
  const root = fixture();
  put(root, '.claude/skills/dev-old/SKILL.md', '# a skill that no longer ships\n');
  put(root, '.claude/skills/dev-old/reference/notes.md', '# nested, and just as gone\n');

  const { orphan, stale, missing } = checkPayload({ sourceRoot: root });
  assert.deepEqual(orphan, [
    join('.claude', 'skills', 'dev-old', 'SKILL.md'),
    join('.claude', 'skills', 'dev-old', 'reference', 'notes.md'),
  ]);
  assert.deepEqual(stale, []);
  assert.deepEqual(missing, []);
});

test('AC6: skills removed from the source are found even when none is planned', () => {
  // The residual case in deriving roots from the plan. One skill removed still
  // leaves a sibling to derive `.claude/skills` from; removing the *last* one
  // leaves nothing, and the sweep then had nowhere to look — installed skills
  // that ship to nobody, reported as a clean tree. The directory is asked
  // directly for this reason.
  const root = mkdtempSync(join(tmpdir(), 'payload-check-'));
  put(root, 'lib/thing.mjs', 'export const thing = 1;\n');
  put(root, '_dev-workflow/lib/thing.mjs', 'export const thing = 1;\n');
  // No `skills/` in the source at all, and two installed skills left behind.
  put(root, '.claude/skills/dev-thing/SKILL.md', '# dev-thing\n');
  put(root, '.claude/skills/dev-old/reference/notes.md', '# nested\n');
  // Still not ours, and still not reported.
  put(root, '.claude/skills/other-tool/SKILL.md', '# not ours\n');

  const { orphan, stale, missing } = checkPayload({ sourceRoot: root });
  assert.deepEqual(orphan, [
    join('.claude', 'skills', 'dev-old', 'reference', 'notes.md'),
    join('.claude', 'skills', 'dev-thing', 'SKILL.md'),
  ]);
  assert.deepEqual(stale, []);
  assert.deepEqual(missing, []);

  rmSync(root, { recursive: true, force: true });
});

test('a file sitting where the skills directory belongs is reported, not thrown', () => {
  // The mirror of the planned-path case: `existsSync` says something is there,
  // not that it is a directory, and `readdirSync` on a file throws ENOTDIR —
  // taking down a check whose useful answer is "the planned skill files are
  // missing".
  const root = mkdtempSync(join(tmpdir(), 'payload-check-'));
  put(root, 'lib/thing.mjs', 'export const thing = 1;\n');
  put(root, '_dev-workflow/lib/thing.mjs', 'export const thing = 1;\n');
  put(root, 'skills/dev-thing/SKILL.md', '# dev-thing\n');
  put(root, '.claude/skills', 'a file, where a directory belongs\n');

  const { missing, stale, orphan } = checkPayload({ sourceRoot: root });
  assert.deepEqual(missing, [join('.claude', 'skills', 'dev-thing', 'SKILL.md')]);
  assert.deepEqual(stale, []);
  assert.deepEqual(orphan, []);

  rmSync(root, { recursive: true, force: true });
});

test('AC6: the installer\'s own config directory is not an orphan', () => {
  // `_config/` is what the installer writes *about* the install — the manifest
  // and the update-check stamp — rather than anything it copied. It is
  // legitimately unplanned, and on a clean checkout it is the only thing under
  // `_dev-workflow/` that is.
  const root = fixture();
  put(root, '_dev-workflow/_config/manifest.json', '{}\n');
  put(root, '_dev-workflow/_config/updatecheck.json', '{}\n');
  put(root, '_dev-workflow/artifacts/documentation/ledger.json', '{}\n');

  assert.deepEqual(checkPayload({ sourceRoot: root }).orphan, []);
});

test('an installed agent the source no longer ships is an orphan; another tool\'s agent is not (#91)', () => {
  const root = fixture();
  put(root, '.claude/agents/dev-old.md', '---\nname: dev-old\n---\n# gone from the source\n');
  put(root, '.claude/agents/other-tool.md', '---\nname: other-tool\n---\n# not ours\n');
  assert.deepEqual(checkPayload({ sourceRoot: root }).orphan, [join('.claude', 'agents', 'dev-old.md')]);
});

test('AC6: a file belonging to another tool is not an orphan', () => {
  // A project is shared ground. `isOwnedPath` is the boundary the installer
  // writes and deletes through, and reporting outside it would be this check
  // claiming ground the installer itself refuses to touch.
  const root = fixture();
  put(root, '.claude/skills/other-tool/SKILL.md', '# not ours\n');
  put(root, '.claude/settings.json', '{}\n');

  assert.deepEqual(checkPayload({ sourceRoot: root }).orphan, []);
});

/**
 * The version stamp is structurally behind, not wrong: the payload is refreshed
 * from a working tree, and `@semantic-release/git` writes the bump back only
 * after the push. So it is worth reporting and must never fail a build.
 */
function versioned(root, { manifest, pkg }) {
  put(root, '_dev-workflow/_config/manifest.json', `${JSON.stringify({ installation: { version: manifest } })}\n`);
  put(root, 'package.json', `${JSON.stringify({ version: pkg })}\n`);
  return root;
}

test('AC7: the version note is printed, and a mismatch still exits 0', () => {
  const root = versioned(fixture(), { manifest: '1.12.0', pkg: '1.13.0' });

  const out = [];
  const code = main([], { sourceRoot: root, write: (s) => out.push(s) });

  assert.equal(code, 0, 'a version mismatch alone is not drift');
  const text = out.join('');
  assert.match(text, /1\.12\.0/);
  assert.match(text, /1\.13\.0/);
});

test('AC7: content drift is what sets the exit code, not the version', () => {
  const root = versioned(fixture(), { manifest: '1.13.0', pkg: '1.13.0' });
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  const out = [];
  assert.equal(
    main([], { sourceRoot: root, write: (s) => out.push(s) }),
    1,
    'matching versions do not excuse a stale file',
  );
  assert.match(out.join(''), /_dev-workflow/);
});

test('AC7: a missing manifest is reported, not thrown', () => {
  const root = fixture();
  put(root, 'package.json', '{"version":"1.13.0"}\n');

  const out = [];
  assert.equal(main([], { sourceRoot: root, write: (s) => out.push(s) }), 0);
  assert.match(out.join(''), /version/i);
});

/**
 * The refresh never writes the payload itself. `isOwnedPath`, the write plan and
 * the delete pass live in `bin/lib/payload.mjs` and are the single
 * implementation of what the installer may touch in a project — a second writer
 * here would be a second copy of that boundary, for the same reason
 * `dev.mjs version --upgrade` spawns the installer rather than unpacking one.
 */
test('AC8: --refresh spawns the installer, then reports the state found afterwards', () => {
  const root = fixture();
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    // Stand in for the installer: only it writes the payload.
    put(root, '_dev-workflow/lib/thing.mjs', 'export const thing = 2;\n');
    return { status: 0 };
  };

  const out = [];
  const code = main(['--refresh'], { sourceRoot: root, write: (s) => out.push(s), spawn });

  assert.equal(calls.length, 1, 'the installer is spawned exactly once');
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(calls[0].args.some((a) => a.endsWith(join('bin', 'install.mjs'))), calls[0].args.join(' '));
  assert.ok(calls[0].args.includes('--update'), calls[0].args.join(' '));
  assert.equal(code, 0, 'the re-check, not the first check, decides the exit code');
});

test('AC8: a refresh that did not fix the drift is still reported as drift', () => {
  const root = fixture();
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  const out = [];
  const code = main(['--refresh'], {
    sourceRoot: root,
    write: (s) => out.push(s),
    spawn: () => ({ status: 0 }), // an installer that wrote nothing
  });

  assert.equal(code, 1, 'the state found afterwards is what is reported, not the one requested');
  assert.match(out.join(''), /thing\.mjs/);
});

test('AC8: an installer that fails is reported, and nothing is claimed for it', () => {
  const root = fixture();
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  const out = [];
  const code = main(['--refresh'], {
    sourceRoot: root,
    write: (s) => out.push(s),
    spawn: () => ({ status: 3 }),
  });

  assert.equal(code, 1);
  // Named exit status, not a generic "install failed" — the first thing a
  // reader needs is whether the installer ran and what it said.
  assert.match(out.join(''), /installer exited 3/);
});

test('AC8: without the flag nothing is spawned at all', () => {
  const root = fixture();
  put(root, 'lib/thing.mjs', 'export const thing = 2;\n');

  let spawned = 0;
  const code = main([], {
    sourceRoot: root,
    write: () => {},
    spawn: () => {
      spawned += 1;
      return { status: 0 };
    },
  });

  assert.equal(spawned, 0, 'the default is read-only');
  assert.equal(code, 1);
});

// --- packaging and wiring ---------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('AC9: npm test runs the check', () => {
  assert.ok(pkg.scripts['check:payload'], 'no check:payload script');
  assert.match(
    pkg.scripts.test,
    /check:payload/,
    'npm test does not run the check, so a PR that edits lib/ without refreshing the copy stays green',
  );
});

test('AC1: the check is repo-local and does not ship', () => {
  assert.ok(!pkg.files.includes('tools'), 'package.json files must not ship tools/');
});

test('AC1: the check imports only node: builtins and the installer payload module', () => {
  const src = readFileSync(join(ROOT, 'tools', 'check-payload.mjs'), 'utf8');
  const specifiers = [...src.matchAll(/^import[^;]*?from '([^']+)';/gm)].map((m) => m[1]);

  assert.ok(specifiers.length > 0, 'no imports found — the scan is not looking at the right thing');
  for (const spec of specifiers) {
    assert.ok(
      spec.startsWith('node:') || spec === '../bin/lib/payload.mjs',
      `unexpected import ${spec}`,
    );
  }
});

test('AC2: the check keeps no second list of payload sources or destinations', () => {
  // The whole point is that `planFiles` decides which files ship and where they
  // land. A literal here would be a second copy of that mapping, and it would go
  // stale silently — reporting a clean tree for a directory it had never heard of.
  //
  // Comments are stripped before the scan. The header has to be able to *explain*
  // what `_dev-workflow/` and `.claude/skills/dev-*` are, and a check that
  // forbade saying so would be pushing the reasoning out of the file that needs
  // it. What must not exist is a directory list the code reads.
  const code = readFileSync(join(ROOT, 'tools', 'check-payload.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const literal of ["'lib'", '"lib"', "'scripts'", "'hooks'", "'skills'", '.claude']) {
    assert.ok(!code.includes(literal), `${literal} is spelled out in tools/check-payload.mjs`);
  }
});
