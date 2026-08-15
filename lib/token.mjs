/**
 * Token resolution, in one place.
 *
 * Order: $YOUTRACK_TOKEN, then 1Password via `op read <ref>`.
 *
 * The security property this file exists to hold: the token is never written to
 * disk and never appears in argv. `op read` is given the *reference*, not the
 * secret, and is spawned with an argument array — never an interpolated shell
 * string — so nothing sensitive can leak through a process listing or a shell
 * history. Callers pass the returned value in a fetch header and nowhere else.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @param {object} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ok: true, token: string} | {ok: false, error: string}>}
 */
export async function resolveToken(config, env = process.env) {
  if (env.YOUTRACK_TOKEN) return { ok: true, token: env.YOUTRACK_TOKEN };

  const ref = config?.tokenOpRef;
  if (!ref) {
    return {
      ok: false,
      error:
        'no token available: set $YOUTRACK_TOKEN, or configure "tokenOpRef" in .dev-workflow.json and sign in to 1Password',
    };
  }

  try {
    const { stdout } = await execFileAsync('op', ['read', ref], { timeout: 30_000 });
    const token = stdout.trim();
    if (!token) return { ok: false, error: `1Password returned nothing for ${ref}` };
    return { ok: true, token };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: `the 1Password CLI (op) is not installed, and "tokenOpRef" is how this project resolves its token — set $YOUTRACK_TOKEN instead`,
      };
    }
    const detail = (err.stderr || err.message || '').trim();
    return { ok: false, error: `op read ${ref} failed: ${detail}` };
  }
}
