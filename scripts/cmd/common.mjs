/**
 * Shared plumbing for the command modules: config + token in one step, and the
 * `@file` argument convention.
 */
import { readFileSync } from 'node:fs';

import { loadConfig } from '../../lib/config.mjs';
import { resolveToken } from '../../lib/token.mjs';

/** Thrown for expected, user-facing failures — yt.mjs prints `.message` alone. */
export class UserError extends Error {}

/**
 * Load the config and resolve the token.
 *
 * @param {{requireProject?: boolean}} [opts]
 * @returns {Promise<{config: object, file: string|null, root: string, token: string}>}
 */
export async function context(opts = {}) {
  const { config, file, root } = loadConfig();

  if (!config.baseUrl) {
    throw new UserError(
      'no YouTrack URL configured — set YOUTRACK_BASE_URL or add "baseUrl" to .dev-workflow.json (run /dev-init)',
    );
  }
  if (opts.requireProject && !config.project) {
    throw new UserError(
      'no project configured — set YOUTRACK_PROJECT or add "project" to .dev-workflow.json',
    );
  }

  const t = await resolveToken(config);
  if (!t.ok) throw new UserError(t.error);

  return { config, file, root, token: t.token };
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
