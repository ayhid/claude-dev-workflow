/**
 * What a project declares it is built with.
 *
 * A stack is read off what a project **declares** — a dependency, a tsconfig, a
 * workspace list — and never off a directory name. `src/react/` is a folder
 * somebody made; a `react` dependency is a fact, and only one of the two
 * survives a tidy-up.
 *
 * Pure, with its reader injected (provider.mjs rule 1) so every awkward case is
 * a fixture rather than a repository, and deterministic (rule 4) so the report
 * it feeds prints the same bytes twice. Nothing here imports `node:fs`.
 *
 * It deliberately discovers **no repositories**. `bin/lib/detect.mjs#findRepos`
 * already walks a checkout for marker files at install time, and its answer is
 * already frozen into `.dev-workflow.json#repos[]`. The axis this adds is the
 * one that is not a repository at all: several packages inside one, which a
 * nested-`.git` scan cannot see by construction.
 */
import { stripJsonc } from './doctrine.mjs';

/**
 * What a declared package tells us the project is.
 *
 * Adding a stack is an entry here and nothing else — the reader below is
 * generic over `kind`, so a language arrives as data rather than as a branch.
 * The entries that name a language nothing in this cut maps a doctrine rule
 * onto are still listed: detecting Python and reporting that nothing decides it
 * is a truer answer than not looking.
 */
export const STACK_SIGNALS = [
  { id: 'nestjs', kind: 'dependency', package: '@nestjs/core', framework: 'nestjs' },
  { id: 'next', kind: 'dependency', package: 'next', framework: 'next' },
  { id: 'python', kind: 'file', path: 'pyproject.toml', language: 'Python' },
  { id: 'react', kind: 'dependency', package: 'react', framework: 'react' },
  { id: 'rust', kind: 'file', path: 'Cargo.toml', language: 'Rust' },
  { id: 'typescript', kind: 'dependency', package: 'typescript', language: 'TypeScript' },
];

/** Where a repository says it holds more than one package. */
export const WORKSPACE_SIGNALS = [
  { id: 'npm', kind: 'json', file: 'package.json', at: 'workspaces' },
  { id: 'nx', kind: 'presence', file: 'nx.json' },
  { id: 'pnpm', kind: 'yaml-packages', file: 'pnpm-workspace.yaml' },
  { id: 'turbo', kind: 'presence', file: 'turbo.json' },
];

/**
 * The tsconfig flags worth reporting, and whether `strict` implies them.
 *
 * Two of these are in the strict family, so `strict: true` switches them on
 * without naming them; two are not, and a config that says nothing about them
 * has them off. Conflating the four is how a project gets told it has a
 * guarantee it does not have.
 */
const TS_FLAGS = [
  { name: 'exactOptionalPropertyTypes', inStrictFamily: false },
  { name: 'noImplicitAny', inStrictFamily: true },
  { name: 'noUncheckedIndexedAccess', inStrictFamily: false },
  { name: 'strictNullChecks', inStrictFamily: true },
];

/** The package fields a dependency can be declared in. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

/** Parse a file as JSON-with-comments, or answer null. Never throws. */
function readJsonc(read, path) {
  let text;
  try {
    text = read(path);
  } catch {
    // Unreadable is not evidence either way, exactly as `detectLinters` treats it.
    return null;
  }
  if (typeof text !== 'string') return null;
  const stripped = stripJsonc(text);
  if (!stripped.ok) return null;
  try {
    return JSON.parse(stripped.text);
  } catch {
    return null;
  }
}

/**
 * The `packages:` list out of a pnpm workspace file.
 *
 * Ten lines of reader for exactly the shape pnpm's own docs write, and a
 * refusal for everything else. There is no YAML parser to reach for — the
 * payload runs from plain source with no `node_modules` — and a reader that
 * guesses at the rest would report a monorepo as a single package, which is the
 * answer that makes every package but the root go unexamined.
 *
 * @returns {string[]|'unknown'}
 */
function pnpmPackages(text) {
  if (typeof text !== 'string') return 'unknown';
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) return 'unknown';

  const packages = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!item) return 'unknown';
    packages.push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  return packages;
}

/** What tsconfig.json says, or that there is none. */
function readTsconfig({ files, read, declared }) {
  const typescript = declared.find((d) => d.id === 'typescript') ?? null;
  const present = new Set(files).has('tsconfig.json');
  const base = {
    present: Boolean(typescript) || present,
    declared: typescript?.range ?? null,
    strict: false,
    extends: null,
    flags: Object.fromEntries(TS_FLAGS.map((f) => [f.name, false])),
  };
  if (!present) return base;

  const config = readJsonc(read, 'tsconfig.json');
  if (!config) return { ...base, strict: 'unknown' };

  const options = config.compilerOptions ?? {};
  if (config.extends) {
    // Following it means node module resolution against the project's own
    // node_modules, which is a different kind of read entirely. Saying so beats
    // reporting the base config as absent.
    const spec = Array.isArray(config.extends) ? config.extends.join(', ') : String(config.extends);
    return { ...base, strict: 'unknown', extends: spec };
  }

  const strict = options.strict === true;
  return {
    ...base,
    strict,
    flags: Object.fromEntries(
      TS_FLAGS.map((f) => [
        f.name,
        typeof options[f.name] === 'boolean' ? options[f.name] : f.inStrictFamily && strict,
      ]),
    ),
  };
}

/** Whether this repository says it holds more than one package, and what it used to say it. */
function readWorkspaces({ files, read }) {
  const present = new Set(files);
  const tools = [];
  const globs = new Set();
  let declaredAny = false;
  let refused = false;

  for (const signal of WORKSPACE_SIGNALS) {
    if (!present.has(signal.file)) continue;

    if (signal.kind === 'presence') {
      tools.push(signal.id);
      continue;
    }

    let list;
    if (signal.kind === 'json') {
      const config = readJsonc(read, signal.file);
      const value = config?.[signal.at];
      if (value === undefined) continue;
      tools.push(signal.id);
      // npm takes an array; yarn also takes `{packages: [...]}`.
      list = Array.isArray(value) ? value : Array.isArray(value?.packages) ? value.packages : 'unknown';
    } else {
      tools.push(signal.id);
      let text = null;
      try {
        text = read(signal.file);
      } catch {
        text = null;
      }
      list = pnpmPackages(text);
    }

    declaredAny = true;
    if (list === 'unknown') refused = true;
    else for (const glob of list) globs.add(glob);
  }

  // Two tools listing different globs is ordinary — pnpm's file usually names
  // more than package.json does — and both are true, so the answer is the union
  // rather than whichever was read first. A refusal anywhere makes the whole
  // answer unknown: a partial list reads exactly like a complete one.
  const packages = !declaredAny ? [] : refused ? 'unknown' : [...globs].sort();

  return { kind: tools.length ? 'workspaces' : 'single', tools: tools.sort(), packages };
}

/**
 * What this project declares it is built with.
 *
 * @param {{files?: string[], read?: (path: string) => string|null}} [input]
 *   `files` is the tracked-path list; `read` answers a path's body or null.
 */
export function detectStack({ files = [], read = () => null } = {}) {
  const present = new Set(files);
  const pkg = present.has('package.json') ? readJsonc(read, 'package.json') : null;
  const versions = Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => pkg?.[field] ?? {}));

  const declared = STACK_SIGNALS.flatMap((signal) => {
    if (signal.kind === 'file') {
      return present.has(signal.path) ? [{ ...signal, range: null }] : [];
    }
    const range = versions[signal.package];
    return range === undefined ? [] : [{ ...signal, range: String(range) }];
  }).sort((a, b) => a.id.localeCompare(b.id));

  return {
    declared,
    frameworks: declared.filter((d) => d.framework).map((d) => d.framework).sort(),
    languages: [...new Set(declared.filter((d) => d.language).map((d) => d.language))].sort(),
    // Its rules need a parser project to run, so it is a tool the project
    // declares rather than something inferred from the presence of ESLint.
    typescriptEslint: Boolean(
      versions['typescript-eslint'] ?? versions['@typescript-eslint/eslint-plugin'],
    ),
    typescript: readTsconfig({ files, read, declared }),
    workspaces: readWorkspaces({ files, read }),
  };
}
