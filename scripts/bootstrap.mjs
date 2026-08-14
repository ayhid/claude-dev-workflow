/**
 * Dependency guard for the runtime scripts. **Zero dependencies of its own** —
 * it is what runs when the dependencies are missing, so it may import nothing
 * but node: builtins.
 *
 * Why this exists: Claude Code installs a plugin by cloning the repo and never
 * runs `npm install`. An installed plugin lives at
 * `~/.claude/plugins/cache/<market>/<plugin>/<version>/` with no `node_modules`,
 * and an upgrade lands in a *new* version-scoped directory — empty again. So a
 * bare `import 'zx'` fails for anyone who installed that way, and fails again
 * after every upgrade.
 *
 * `/yt-init` and the npx installer install dependencies up front, which is the
 * common path. This is the fallback that makes the uncommon path work anyway,
 * and turns the failure into a sentence instead of ERR_MODULE_NOT_FOUND.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Is `name` resolvable from here? */
export function isInstalled(name) {
  // import.meta.resolve throws when the specifier cannot be resolved. It is
  // unflagged from Node 18.19, so fall back to a filesystem probe below.
  if (typeof import.meta.resolve === 'function') {
    try {
      import.meta.resolve(name);
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(join(PLUGIN_ROOT, 'node_modules', name, 'package.json'));
}

/**
 * Run `npm install` in the plugin root.
 *
 * npm's own output goes to **stderr**, never stdout: `yt.mjs create` prints only
 * the new issue ID to stdout so callers can capture it, and an install log in
 * that stream would corrupt it.
 */
function npmInstall() {
  return new Promise((done) => {
    const child = spawn(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: PLUGIN_ROOT, stdio: ['ignore', 2, 2] },
    );
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

/**
 * Ensure `names` are installed, installing them once if they are not.
 *
 * Only call this from a command that genuinely needs them — `config`, `fetch`,
 * `update` and `create` are plain HTTP and deliberately depend on nothing, so
 * they keep working even in a freshly cloned plugin with no node_modules.
 *
 * @param {string[]} names
 * @returns {Promise<void>} rejects with an actionable message if it cannot
 */
export async function ensureDeps(names) {
  const missing = names.filter((n) => !isInstalled(n));
  if (missing.length === 0) return;

  process.stderr.write(
    `yt: ${missing.join(', ')} not installed — running npm install in ${PLUGIN_ROOT}\n` +
      `    (plugin installs do not do this themselves; this happens once per version)\n`,
  );

  if (!existsSync(join(PLUGIN_ROOT, 'package.json'))) {
    throw new Error(
      `cannot install ${missing.join(', ')}: no package.json at ${PLUGIN_ROOT}. ` +
        `This does not look like a complete plugin checkout.`,
    );
  }

  const ok = await npmInstall();
  const stillMissing = names.filter((n) => !isInstalled(n));

  if (!ok || stillMissing.length > 0) {
    throw new Error(
      `could not install ${stillMissing.join(', ') || missing.join(', ')}.\n` +
        `Run this by hand, then retry:\n` +
        `  npm install --omit=dev --prefix "${PLUGIN_ROOT}"`,
    );
  }
}
