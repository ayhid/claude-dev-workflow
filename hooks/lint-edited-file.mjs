#!/usr/bin/env node
/**
 * PostToolUse hook: lint the one file that was just written, and hand the
 * findings back.
 *
 * An A/B eval of the clean-code doctrine found that the rules a linter can
 * decide scored the same with the doctrine in the prompt as without it, while
 * the semantic ones carried the whole gain. So the mechanical half belongs in
 * the linter — and a linter the model only meets at commit time, or in CI, is
 * one whose findings arrive after the code is written and moved on from. This
 * closes that loop at the edit: one file, one run, findings straight back.
 *
 * `dev.mjs rules --doctrine` is what decides which rules should be there. This
 * hook is what makes them worth having.
 *
 * ## Why this is Node, when hooks/ is otherwise bash and jq
 *
 * Argued from scratch, as CLAUDE.md asks of every Node hook rather than
 * letting the two existing ones become a precedent. Four reasons:
 *
 * 1. The ~3ms budget that keeps `check-commit-ticket.sh` in bash is a fact
 *    about `PreToolUse` with `matcher: "Bash"`: it fires on every command, so
 *    its bail has to be cheaper than an interpreter boot. This is
 *    `PostToolUse` on `Edit|Write`, which is where `check-adr-immutable.sh`
 *    already sits and already affords reading its target. And decisively: this
 *    hook exists to spawn a linter, which costs hundreds of milliseconds at
 *    best. A 50ms boot against a 500ms lint is not a budget question.
 *
 * 2. It has to bound a runtime that is not ours. The model waits while a
 *    PostToolUse hook runs, and a single-file lint is usually sub-second but a
 *    cold `npx` resolution, a typescript-eslint project service starting up, or
 *    a large flat config can take tens of seconds. `timeout(1)` is not on a
 *    stock macOS — that is `gtimeout`, from coreutils — so bash cannot cap a
 *    subprocess portably. `spawnSync`'s `timeout` can, with no dependency and
 *    no platform check.
 *
 * 3. It needs three tables that already live in `lib/`: which extensions a
 *    linter handles (`LANGUAGE_BY_EXTENSION`), which config filenames mean
 *    which linter is set up (`LINTERS`, twenty-odd spellings per tool), and how
 *    that linter lints one file (`lintFile`). In Node those are imports. In
 *    bash they are three transcriptions that go stale in silence, and a second
 *    copy of a table is the drift this repo refuses everywhere else.
 *
 * 4. Bash's degradation mode is wrong for *this* hook in particular. Without
 *    `jq`, `check-adr-immutable.sh` stops enforcing and says so, and a human
 *    notices the warning. Here the findings *are* the output, so producing
 *    nothing is indistinguishable from "the file is clean" — and nobody ever
 *    notices a lint error that did not arrive.
 *
 * The zero-dependency rule binds in full: this runs from the installed copy in
 * someone else's Python or Rust repo.
 *
 * ## It may never fail a session, and it writes nothing
 *
 * Exit 2 is reserved for findings, because exit 2 is what puts stderr in front
 * of the model. **Every other path exits 0 in silence** — no config, switched
 * off, a file this linter does not handle, a linter that will not start, a
 * linter that errors without findings, a run past the ceiling, anything thrown.
 * A broken lint config must not fire on every edit for the rest of the day.
 *
 * Output is capped. CLAUDE.md's cost model is that a token added early is paid
 * for by every turn after it, and a file with three hundred violations must not
 * put three hundred lines into a session's context because somebody saved it.
 *
 * Nothing is cached and nothing is stamped: `detectLinters` over a handful of
 * `existsSync` calls costs microseconds, so a cache would buy nothing and would
 * be a staleness bug waiting to happen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { detectLinters, LANGUAGE_BY_EXTENSION, LINTERS } from '../lib/rules.mjs';

/** The ceiling on the linter itself. */
const BUDGET_MS = 5000;
/**
 * The ceiling on the whole hook — the subprocess plus our own reading. One
 * second of slack over BUDGET_MS, so the normal timeout path is the one that
 * fires and this is only ever the backstop.
 */
const HARD_MS = 6000;
/** How many finding lines are worth a session's context. */
const MAX_LINES = 20;

/** Read the hook payload without holding the event loop. */
function payloadFromStdin(timeoutMs) {
  return new Promise((done) => {
    let raw = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        done(JSON.parse(raw));
      } catch {
        // Not JSON is not an error here; there is simply nothing to act on.
        done(null);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        raw += chunk;
        // A complete object is the whole payload; do not wait for a close a
        // host may never send.
        try {
          JSON.parse(raw);
          finish();
        } catch {
          /* not complete yet */
        }
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

/**
 * The configured repo holding this file, by longest matching path.
 *
 * `resolveRepo` in `scripts/cmd/common.mjs` answers a different question — it
 * takes a repo's *name* — so it does not fit. In a monorepo the linter lives in
 * the package, not at the root, and running the root's command against a
 * package's file is how a hook reports a config error on every edit.
 */
function repoFor(config, root, filePath) {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const from = dirname(filePath);
  let best = null;

  for (const repo of repos) {
    const dir = resolve(root, repo.path ?? '.');
    const inside = relative(dir, from);
    if (inside.startsWith('..') || isAbsolute(inside)) continue;
    if (best === null || dir.length > best.dir.length) best = { dir, repo };
  }
  return best ?? { dir: root, repo: repos.find((r) => (r.path ?? '.') === '.') ?? {} };
}

/**
 * The command that lints one file, and the languages it covers.
 *
 * Three sources, in order, and never an inference (contract rule 2). A
 * configured `lintFile` is the only thing that can express a project's own
 * wrapper, so it wins; the detected linter's own recipe is the fallback; and
 * neither means this hook has nothing to say. It does not invent a linter.
 */
function commandFor({ dir, repo }) {
  const configured = repo?.lintFile;
  if (Array.isArray(configured) && configured.length > 0) {
    // `languages: null` means "any language a linter could handle" rather than
    // "any file": only the project knows which of them its own wrapper covers,
    // but no wrapper wants a README, and the caller's first gate still applies.
    return { argv: configured, languages: null, source: 'config' };
  }

  // A file list from the config filenames themselves, so the detector needs no
  // `git ls-files` spawn on a path the model is waiting on.
  const candidates = [
    ...new Set(LINTERS.flatMap((l) => [...l.configs, ...l.embedded.map((e) => e.file)])),
  ];
  const files = candidates.filter((name) => existsSync(join(dir, name)));
  const found = detectLinters({ files, read: () => null }).find((l) => l.lintFile);
  if (!found) return null;

  return {
    argv: found.lintFile.split(/\s+/),
    languages: new Set(found.language.split(',').map((s) => s.trim())),
    source: found.name,
  };
}

/**
 * Findings, sorted and capped, or null when there are none worth printing.
 *
 * **Only stdout.** Every formatter either tool has — `eslint --format=compact`,
 * `biome lint` — writes findings there and keeps its own failures on stderr, so
 * reading both makes a broken config look like a violation and fire on every
 * edit for the rest of the day. Silence is the honest output for "the linter
 * could not tell us", and it is the one a person actually recovers from,
 * because they find out the next time they run the linter themselves.
 */
function findings(stdout) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  // Sorted so two runs over one unchanged file print the same bytes, which is
  // what keeps a re-edit from reading as a new problem.
  const sorted = [...lines].sort();
  const shown = sorted.slice(0, MAX_LINES);
  if (sorted.length > shown.length) shown.push(`… and ${sorted.length - shown.length} more`);
  return shown.join('\n');
}

async function main() {
  const payload = await payloadFromStdin(500);
  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return;

  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

  let loaded;
  try {
    loaded = loadConfig({ dir: projectDir });
  } catch {
    return;
  }
  // No config file: /dev-init has not run here, and `.claude/settings.json` is
  // shared ground — this stays silent rather than advertising itself.
  if (!loaded.file) return;
  if (loaded.config?.hooks?.lintEdit === false) return;

  const absolute = resolve(projectDir, filePath);
  const { dir, repo } = repoFor(loaded.config, loaded.root, absolute);
  const command = commandFor({ dir, repo });
  if (!command) return;

  // Silent on a file the linter does not handle, in two steps. First: is this a
  // source file at all? A README, a lockfile or a YAML workflow is not
  // something a per-file linter should be handed, and that holds even for a
  // command the project configured itself — a wrapper written for its source
  // tree was not written for its documentation.
  const dot = absolute.lastIndexOf('.');
  const language = dot === -1 ? null : LANGUAGE_BY_EXTENSION[absolute.slice(dot).toLowerCase()];
  if (!language) return;
  // Second: when we detected the linter ourselves, it has to be a language that
  // linter covers. A `.py` in a repo whose linter is ESLint is not a finding.
  if (command.languages && !command.languages.has(language)) return;

  // Relative to the repo the linter runs in, so its own output names the file
  // the way the project does. Outside it, the absolute path is all we have.
  const inside = relative(dir, absolute);
  const target = inside.startsWith('..') ? absolute : inside.split(sep).join('/');

  const argv = command.argv.map((token) => (token === '<FILE>' ? target : token));
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: dir,
    timeout: BUDGET_MS,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    // stdin closed: a linter that decides to read it would hang on a model's
    // turn, and none of them needs it to lint a path.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // A linter that never started, or that we cut off, has told us nothing about
  // the file. Neither is a finding.
  if (result.error || result.signal) return;
  if (result.status === 0) return;

  const report = findings(result.stdout ?? '');
  if (!report) return;

  process.stderr.write(
    `${command.source === 'config' ? 'lint' : command.source} on ${target}:\n${report}\n`,
  );
  process.exitCode = 2;
}

// The backstop, and the only non-zero exit is the one main() sets for findings.
// `unref` so a fast run is not held open by its own timer.
setTimeout(() => process.exit(0), HARD_MS).unref();

main()
  .catch(() => {
    // A lint finding is never worth a broken session.
  })
  .finally(() => {
    process.stdin.destroy();
  });
