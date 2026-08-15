/**
 * Shared plumbing for the command modules: config + provider in one step, and
 * the `@file` argument convention.
 */
import { readFileSync } from 'node:fs';

import { loadConfig } from '../../lib/config.mjs';
import { makeProvider } from '../../lib/provider.mjs';

/** Thrown for expected, user-facing failures — dev.mjs prints `.message` alone. */
export class UserError extends Error {}

/**
 * Load the config and build the provider for it.
 *
 * This is the seam. It used to hard-require a YouTrack URL and then a resolved
 * token before any command could run, which is why the tool could only ever
 * have one backend: GitHub has neither. Now it validates only what is
 * genuinely universal — that a project is named when the command needs one —
 * and hands off everything backend-specific to the adapter, which knows what
 * *its* credentials look like.
 *
 * @param {{requireProject?: boolean}} [opts]
 * @returns {Promise<{config: object, file: string|null, root: string, provider: object}>}
 */
export async function context(opts = {}) {
  const { config, file, root } = loadConfig();

  if (opts.requireProject && !config.project) {
    throw new UserError(
      'no project configured — add "project" to .dev-workflow.json (run /dev-init)',
    );
  }

  const r = await makeProvider(config);
  if (!r.ok) throw new UserError(r.error);

  return { config, file, root, provider: r.provider };
}

/**
 * Resolve an argument that may be literal text or `@path` to read a file.
 * A leading `@@` escapes to a literal '@'.
 */
export function readArg(value, what = 'file') {
  if (typeof value !== 'string') return value;
  if (value.startsWith('@@')) return value.slice(1);
  if (!value.startsWith('@')) return value;

  const path = value.slice(1);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new UserError(`${what} not found: ${path}`);
  }
}

/** Unwrap a { ok, data, error } result or throw its message. */
export function must(result) {
  if (!result.ok) throw new UserError(result.error);
  return result.data;
}
