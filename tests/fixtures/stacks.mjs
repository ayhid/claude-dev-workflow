/**
 * Projects to detect, as in-memory trees.
 *
 * Every reader in `lib/stack.mjs`, `lib/rules.mjs` and `lib/doctrine.mjs` takes
 * `{files, read}` rather than a directory, so a fixture is data and no test
 * needs a repository on disk. They live here rather than in one test file
 * because three suites ask different questions of the same five projects, and
 * a second copy of "what a Next.js repo looks like" is a second thing to keep
 * true.
 *
 * `files` is the tracked-path list `git ls-files` would give; `tree` is the
 * body of the files a reader actually opens.
 */

/** A reader over one of the trees below. */
export const reader = (tree) => (path) => (path in tree ? tree[path] : null);

const json = (value) => JSON.stringify(value, null, 2);

/** TypeScript, React, Next, ESLint with typescript-eslint, linted in CI. */
export const TS_FULL = {
  files: [
    '.github/workflows/ci.yml',
    'eslint.config.mjs',
    'package.json',
    'src/index.ts',
    'src/ui/button.tsx',
    'tsconfig.json',
  ],
  tree: {
    'package.json': json({
      name: 'app',
      scripts: { build: 'next build', lint: 'eslint .', test: 'vitest run' },
      dependencies: { next: '^15.0.0', react: '^19.0.0' },
      devDependencies: {
        eslint: '^9.12.0',
        typescript: '^5.6.2',
        'typescript-eslint': '^8.8.0',
      },
    }),
    'tsconfig.json': json({
      compilerOptions: { strict: true, noUncheckedIndexedAccess: false, target: 'ES2022' },
    }),
    'eslint.config.mjs': "export default [{ rules: { 'max-params': ['warn', 2] } }];\n",
    '.github/workflows/ci.yml': 'jobs:\n  ci:\n    steps:\n      - run: npm run lint\n      - run: npm test\n',
  },
};

/** TypeScript and nothing to check it with. */
export const TS_BARE = {
  files: ['package.json', 'src/index.ts', 'tsconfig.json'],
  tree: {
    'package.json': json({ name: 'bare', devDependencies: { typescript: '^5.6.2' } }),
    'tsconfig.json': json({ compilerOptions: { strict: false } }),
  },
};

/** Biome, on its recommended preset plus one rule of its own. */
export const BIOME = {
  files: ['biome.json', 'package.json', 'src/app.ts'],
  tree: {
    'package.json': json({ name: 'biomed', devDependencies: { '@biomejs/biome': '^1.9.0' } }),
    'biome.json': json({
      linter: {
        enabled: true,
        rules: { recommended: true, suspicious: { noEmptyBlockStatements: 'error' } },
      },
    }),
  },
};

/** One repository, several packages, and a linter in only one of them. */
export const MONO = {
  files: [
    'package.json',
    'packages/api/package.json',
    'packages/api/src/server.ts',
    'packages/web/eslint.config.mjs',
    'packages/web/package.json',
    'packages/web/src/a.tsx',
    'pnpm-workspace.yaml',
    'turbo.json',
  ],
  tree: {
    'package.json': json({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "tools/*"\n',
    'turbo.json': json({ tasks: { build: {} } }),
    'packages/web/package.json': json({ name: 'web', devDependencies: { eslint: '^9.0.0' } }),
    'packages/api/package.json': json({ name: 'api' }),
  },
};

/** Nothing this tool can name. */
export const NO_STACK = {
  files: ['Makefile', 'README.md', 'main.go'],
  tree: { Makefile: 'test:\n\tgo test ./...\n' },
};

/** Every fixture, for the sweeps that assert something of all of them. */
export const FIXTURES = { TS_FULL, TS_BARE, BIOME, MONO, NO_STACK };
