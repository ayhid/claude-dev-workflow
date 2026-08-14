/**
 * Read the target project and answer what the installer would otherwise have
 * to ask: repo layout, package manager, check commands, commit types, remotes.
 *
 * Everything here is best-effort and every result is shown to the user for
 * confirmation — a wrong guess costs a keystroke, never a bad config.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/** pnpm / yarn / npm / bun, from the lockfile or the packageManager field. */
export function packageManager(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared) return declared;
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  return pkg ? 'npm' : null;
}

/**
 * Plausible verification commands, in the order they should run.
 *
 * Watch-mode targets are deliberately skipped: a bare `test` script that runs
 * vitest or jest without --run never exits, which would hang /done forever.
 */
export function checkCommands(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  const pm = packageManager(dir) || 'npm';
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);

  if (pkg?.scripts) {
    const scripts = pkg.scripts;
    const isWatch = (name) => {
      const body = scripts[name] || '';
      if (/--watch(?![-\w])/.test(body)) return true;
      // Bare `vitest` / `jest --watch` default to watch mode.
      return /^\s*vitest\s*$/.test(body);
    };
    const pick = (...names) => names.find((n) => scripts[n] && !isWatch(n));

    const out = [];
    const test = pick('test:ci', 'test:run', 'test:unit', 'test');
    if (test) out.push(run(test));
    const lint = pick('lint');
    if (lint) out.push(run(lint));
    const types = pick('type-check', 'typecheck', 'tsc');
    if (types) out.push(run(types));
    if (out.length) return out;
  }

  if (existsSync(join(dir, 'Makefile'))) return ['make test'];
  if (existsSync(join(dir, 'Cargo.toml'))) return ['cargo test', 'cargo clippy'];
  if (existsSync(join(dir, 'go.mod'))) return ['go test ./...', 'go vet ./...'];
  if (existsSync(join(dir, 'pyproject.toml'))) return ['pytest'];
  if (existsSync(join(dir, 'Gemfile'))) return ['bundle exec rspec'];
  return [];
}

/**
 * Conventional-commit types and scopes from the project's own commitlint
 * config. JS configs are grepped rather than imported — importing arbitrary
 * project code during an install is not worth the convenience.
 */
export function commitConvention(dir) {
  const candidates = [
    '.commitlintrc',
    '.commitlintrc.json',
    'commitlint.config.js',
    'commitlint.config.mjs',
    'commitlint.config.cjs',
    'commitlint.config.ts',
    '.commitlintrc.js',
  ];

  const pkg = readJson(join(dir, 'package.json'));
  const fromPkg = pkg?.commitlint?.rules;
  const pull = (rules, key) => {
    const rule = rules?.[key];
    return Array.isArray(rule) && Array.isArray(rule[2]) ? rule[2] : null;
  };
  if (fromPkg) {
    const types = pull(fromPkg, 'type-enum');
    const scopes = pull(fromPkg, 'scope-enum');
    if (types || scopes) return { types, scopes, source: 'package.json' };
  }

  for (const name of candidates) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const json = readJson(p);
    if (json?.rules) {
      const types = pull(json.rules, 'type-enum');
      const scopes = pull(json.rules, 'scope-enum');
      if (types || scopes) return { types, scopes, source: name };
    }
    // JS config: pull the array literal out of type-enum / scope-enum.
    const src = (() => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    })();
    const grab = (key) => {
      const m = src.match(new RegExp(`['"\`]?${key}['"\`]?\\s*:\\s*\\[[\\s\\S]{0,400}?\\[([\\s\\S]*?)\\]`));
      if (!m) return null;
      const items = m[1].match(/['"`]([^'"`]+)['"`]/g);
      return items ? items.map((s) => s.slice(1, -1)) : null;
    };
    const types = grab('type-enum');
    const scopes = grab('scope-enum');
    if (types || scopes) return { types, scopes, source: name };
  }
  return { types: null, scopes: null, source: null };
}

/** Runtime pins a version manager may not resolve on its own. */
export function envPins(dir) {
  const env = {};
  const toolVersions = join(dir, '.tool-versions');
  if (existsSync(toolVersions)) {
    try {
      for (const line of readFileSync(toolVersions, 'utf8').split('\n')) {
        const [tool, version] = line.trim().split(/\s+/);
        // A literal version is fine; an alias like `lts` is what asdf chokes on.
        if (tool === 'nodejs' && version && /^\d/.test(version)) {
          env.ASDF_NODEJS_VERSION = version;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return env;
}

const isRepo = (dir) => existsSync(join(dir, '.git'));

/** Remote names, in the order git lists them. */
export function remotes(dir) {
  const out = git(dir, ['remote']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** The default branch, from origin/HEAD, then a guess among the usual names. */
export function baseBranch(dir) {
  const head = git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace('refs/remotes/origin/', '');
  const branches = git(dir, ['branch', '-a', '--format=%(refname:short)']).split('\n');
  for (const name of ['main', 'master', 'develop']) {
    if (branches.some((b) => b === name || b.endsWith(`/${name}`))) return name;
  }
  return git(dir, ['branch', '--show-current']) || 'main';
}

/** How issue IDs actually appear in this project's history so far. */
export function commitIdPosition(dir) {
  const log = git(dir, ['log', '--oneline', '--no-merges', '-50', '--format=%s']);
  if (!log) return null;
  let prefix = 0;
  let suffix = 0;
  for (const subject of log.split('\n')) {
    if (!/[A-Z][A-Z0-9]*-\d+/.test(subject)) continue;
    if (/^[A-Z][A-Z0-9]*-\d+/.test(subject)) prefix += 1;
    else if (/[A-Z][A-Z0-9]*-\d+\)?\s*$/.test(subject)) suffix += 1;
  }
  if (prefix === 0 && suffix === 0) return null;
  return prefix > suffix ? 'prefix' : 'suffix';
}

/**
 * Candidate repos: the root itself, plus one level of subdirectories that look
 * like their own project. A nested .git means a separate repo, not a monorepo
 * package — the distinction matters because a branch lives in exactly one.
 */
export function findRepos(root) {
  const marker = (dir) =>
    ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'composer.json', 'Gemfile'].some((f) =>
      existsSync(join(dir, f)),
    );

  const candidates = [];
  if (marker(root) || isRepo(root)) candidates.push({ path: '.', dir: root });

  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return candidates;
  }

  const skip = new Set(['node_modules', 'worktrees', 'dist', 'build', 'vendor', '.git', 'target', '_archive']);
  for (const name of entries.sort()) {
    if (name.startsWith('.') || skip.has(name)) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (marker(dir) || isRepo(dir)) candidates.push({ path: name, dir });
  }
  return candidates;
}

/** Everything worth recording about one repo. */
export function describeRepo({ path, dir }) {
  const conv = commitConvention(dir);
  return {
    path,
    dir,
    isGitRepo: isRepo(dir),
    packageManager: packageManager(dir),
    checks: checkCommands(dir),
    env: envPins(dir),
    remotes: remotes(dir),
    scopes: conv.scopes,
    types: conv.types,
    conventionSource: conv.source,
  };
}
