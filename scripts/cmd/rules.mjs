/**
 * What this project already enforces, and what it merely states.
 *
 *   dev.mjs rules [--repo PATH] [--json]
 *
 * The inventory `/dev-lint-rules` starts from. It reports and never writes: a
 * rule switched on changes what CI does, and that is the user's decision (the
 * skill's first refusal).
 *
 * It is a command rather than a table in the skill for the reason CLAUDE.md
 * gives for the metrics wrapper and the `git()` choke point — cost is context
 * multiplied by turns, so work a command can hand over in one turn should not
 * be a list of file-existence checks the model walks every session. It also
 * makes the skill's second acceptance criterion a guarantee instead of an
 * instruction: nothing already configured can be proposed again if the
 * configured set is read mechanically.
 *
 * No tracker and no network — `loadConfig()` directly, like `docs`, so it runs
 * without a token.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../../lib/config.mjs';
import {
  collectSuggestions,
  coverageOf,
  parseBiomeConfig,
  renderDoctrine,
  renderSuggestion,
  summarise,
} from '../../lib/doctrine.mjs';
import {
  detectInvocations,
  detectLinters,
  LANGUAGE_BY_EXTENSION,
  languagesOf,
  renderRules,
  resolveArgv,
  resolveRecipe,
  statedSources,
} from '../../lib/rules.mjs';
import { detectStack } from '../../lib/stack.mjs';
import { sh } from '../../lib/sh.mjs';
import { ARTIFACT_DIR } from './ingest.mjs';
import { resolveRepo, takeValue, UserError } from './common.mjs';

const LEDGER = 'ledger.json';

const USAGE = 'usage: dev.mjs rules [--repo PATH] [--doctrine] [--json]';

export function parseArgs(argv) {
  const opts = { doctrine: false, json: false, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--doctrine') opts.doctrine = true;
    else if (a === '--repo') opts.repo = takeValue(argv, ++i, a);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new UserError(`unknown argument '${a}'\n\n${USAGE}`);
  }
  return opts;
}

/** Tracked files only, so an ignored `node_modules` never has to be excluded. */
async function trackedFiles(dir, run) {
  const r = await run('git', ['-C', dir, 'ls-files']);
  return r.ok && r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
}

/**
 * The ledger's claims, or none.
 *
 * A project with no documentation ledger is the normal case, not an error —
 * `/dev-ingest-docs` may simply never have been run here.
 */
function ledgerClaims(root) {
  const path = join(root, ARTIFACT_DIR, LEDGER);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.claims) ? parsed.claims : [];
  } catch {
    // A half-written ledger is somebody else's problem to report; here it just
    // contributes nothing rather than failing the inventory.
    return [];
  }
}


/** The extensions a linter's language covers, best first. */
const TARGET_ORDER = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

/**
 * The files a linter could be asked to resolve a configuration for, best first.
 *
 * ESLint resolves **per path**, so a repository with per-directory overrides has
 * no single answer — one has to be picked, and the pick has to be the same on
 * every run or the report stops being diffable (rule 4). Hence a deterministic
 * order rather than a choice.
 *
 * It is a list rather than one file because a flat config with no `files` key
 * matches `.js` and not `.ts`, and ESLint answers the literal word `undefined`
 * for a file no config object covers. Asking only about the sorted-first source
 * file therefore reported every rule unknown in a project whose configuration
 * was sitting right there. The caller walks this until one answers.
 */
function resolveTargets(files, language) {
  const covers = new Set(language.split(',').map((s) => s.trim()));
  const candidates = files
    .filter((f) => covers.has(LANGUAGE_BY_EXTENSION[f.slice(f.lastIndexOf('.')).toLowerCase()] ?? ''))
    .sort();
  const ordered = TARGET_ORDER.flatMap((ext) => candidates.filter((f) => f.toLowerCase().endsWith(ext)));
  // Capped: each one is a spawn, and a repo whose config matches nothing should
  // cost a handful of probes rather than one per source file.
  return [...new Set([...ordered, ...candidates])].slice(0, 6);
}

/**
 * Does this resolved ESLint configuration have type information?
 *
 * typescript-eslint's rules cannot run without it, so a project with no parser
 * project is told its coverage is unknown rather than told the rules are
 * missing — a suggestion it could not apply is worse than no suggestion.
 */
function isTypeAware(config) {
  const options = config?.languageOptions?.parserOptions ?? config?.parserOptions ?? {};
  return Boolean(options.project || options.projectService || options.EXPERIMENTAL_useProjectService);
}

/**
 * Ask the tool for its resolved configuration, walking the candidate files
 * until one of them is covered by it.
 *
 * Three distinct outcomes, and a reader needs to be told which: the tool could
 * not start, the tool ran but its configuration covers none of these files, or
 * an answer. Only the last is evidence about a rule.
 */
async function resolveByRunning({ linter, targets, dir, runner }) {
  const unmatched = [];

  for (const target of targets) {
    const argv = resolveArgv(linter, target);
    const command = resolveRecipe(linter, target);
    const result = await runner(argv[0], argv.slice(1), { cwd: dir, timeout: 60_000 });

    if (!result.ok) {
      // Never swallow stderr from a failed probe: its first line is usually the
      // whole diagnosis, and the one time only the exit code surfaced the error
      // underneath named the problem exactly.
      const reason = result.code === 127
        ? `${linter.name} is configured but not installed — run your package manager's install`
        : (result.stderr.split('\n')[0] || `exit ${result.code}`);
      return { answer: { ok: false, reason }, resolveReport: { source: 'run', ok: false, target, command, reason } };
    }

    // ESLint prints the literal word `undefined` for a file no config object
    // matches. That is an answer about the file, not a failure of the tool, so
    // the next candidate is tried rather than the whole thing being given up on.
    if (result.stdout.trim() === 'undefined' || result.stdout.trim() === '') {
      unmatched.push(target);
      continue;
    }

    let config;
    try {
      config = JSON.parse(result.stdout);
    } catch (err) {
      const reason = `could not read ${linter.name}'s resolved configuration: ${err.message}`;
      return { answer: { ok: false, reason }, resolveReport: { source: 'run', ok: false, target, command, reason } };
    }

    return {
      answer: { ok: true, source: 'run', rules: config.rules ?? {}, typeAware: isTypeAware(config) },
      resolveReport: {
        source: 'run',
        ok: true,
        target,
        command,
        ruleCount: Object.keys(config.rules ?? {}).length,
        ...(unmatched.length ? { unmatched } : {}),
      },
    };
  }

  // An ESLint config that matches none of the repo's own source files is a
  // real finding about the project, and a different one from a missing rule.
  const reason =
    `${linter.name}'s configuration matches none of ${unmatched.join(', ')} — ` +
    'a config object needs a `files` pattern covering this project\'s sources';
  return { answer: { ok: false, reason }, resolveReport: { source: 'run', ok: false, reason } };
}

/**
 * What each configured linter's own configuration says, and whether anything
 * runs it.
 *
 * Every spawn goes through the injected runner, so this is offline in a test
 * and never reaches for a network. A tool that cannot start is reported as
 * exactly that: not installed is a fact about the checkout, not evidence about
 * a rule (contract rule 2).
 */
async function inspectTooling({ dir, files, read, linters, stack, runner }) {
  const namedIn = detectInvocations({ files, read, linters });
  const tooling = [];
  const resolved = {};
  const tools = [];

  for (const linter of linters) {
    if (!['eslint', 'biome'].includes(linter.name)) continue;

    const dialect = linter.name === 'biome'
      ? 'biome'
      : linter.configs.some((c) => c.startsWith('.eslintrc')) ? 'eslintrc' : 'flat';

    const probe = await runner('npx', ['--no-install', linter.name, '--version'], { cwd: dir, timeout: 30_000 });
    const installed = probe.code !== 127;

    let answer;
    let resolveReport;
    if (linter.resolveKind === 'config') {
      answer = parseBiomeConfig({ files, read });
      resolveReport = { source: 'config', ok: answer.ok, ...(answer.ok ? {} : { reason: answer.reason }) };
    } else {
      const targets = resolveTargets(files, linter.language);
      if (targets.length === 0) {
        answer = { ok: false, reason: `nothing in this repo for ${linter.name} to resolve a configuration against` };
        resolveReport = { source: 'run', ok: false, reason: answer.reason };
      } else {
        ({ answer, resolveReport } = await resolveByRunning({ linter, targets, dir, runner }));
      }
    }

    resolved[linter.name] = answer;
    tools.push(linter.name);
    // typescript-eslint answers out of the same resolved configuration, since
    // its rules live in it — but only when the project declares the plugin.
    if (linter.name === 'eslint' && stack.typescriptEslint) {
      resolved.typescriptEslint = answer;
      tools.push('typescriptEslint');
    }

    tooling.push({
      name: linter.name,
      language: linter.language,
      configs: linter.configs,
      dialect,
      installed,
      namedIn: namedIn[linter.name] ?? [],
      resolve: resolveReport,
    });
  }

  return { tooling: tooling.sort((a, b) => a.name.localeCompare(b.name)), resolved, tools: tools.sort() };
}

export async function run(argv, { run: runner = sh } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { config, root } = loadConfig();
  const configured = resolveRepo(config, root, opts.repo);
  const dir = configured.dir;

  const files = await trackedFiles(dir, runner);
  const read = (path) => {
    try {
      return readFileSync(join(dir, path), 'utf8');
    } catch {
      return null;
    }
  };

  const repo = config.repos?.find((r) => r.path === configured.path);
  const input = {
    linters: detectLinters({ files, read }),
    checks: repo?.checks ?? [],
    sources: statedSources(files),
    claims: ledgerClaims(root),
    languages: languagesOf(files),
  };

  let doctrine = null;
  if (opts.doctrine) {
    const stack = detectStack({ files, read });
    const { tooling, resolved, tools } = await inspectTooling({
      dir, files, read, linters: input.linters, stack, runner,
    });
    const coverage = coverageOf({ resolved, tools });
    const dialect = tooling.find((t) => t.dialect)?.dialect ?? 'flat';
    doctrine = {
      stack,
      tooling,
      coverage,
      summary: summarise(coverage),
      suggestions: collectSuggestions(coverage, { dialect }),
      dialect,
    };
  }

  if (opts.json) {
    // The recipes go out with the rest: an agent reading this should not have
    // to know the table to produce a violation count.
    const body = { repo: configured.path, ...input };
    if (doctrine) {
      body.stack = doctrine.stack;
      body.tooling = doctrine.tooling;
      // Per rule for the table the skill builds, and merged for the paste:
      // two doctrine rules can want one tool rule, and only the merged form is
      // safe to put in a config.
      body.doctrine = doctrine.coverage.map((entry) => ({
        ...entry,
        suggestion: renderSuggestion(entry, { dialect: doctrine.dialect }),
      }));
      body.suggestions = doctrine.suggestions;
      body.summary = doctrine.summary;
    }
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }

  const report = renderRules(input) + (doctrine ? `\n${renderDoctrine(doctrine)}` : '');
  process.stdout.write(`repo:     ${configured.path} (${dir})\n\n${report}`);
  return 0;
}
