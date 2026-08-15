/**
 * Running external commands, with no dependencies.
 *
 * The installed payload under `_youtrack/` must work in any project — including
 * ones with no `package.json` at all — so it carries no `node_modules`. This is
 * the handful of behaviours we actually used zx for.
 *
 * Every call takes an **argument array**, never an interpolated shell string.
 * That is not a style preference: it is what guarantees an argument containing
 * a space, a quote or a `$` reaches the program intact, and it is why nothing
 * sensitive can leak through shell history or a process listing.
 */
import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a command and capture its output. Never throws on a non-zero exit — a
 * failing probe is normal here — so callers must check `ok` or `code`.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string}>}
 */
export function sh(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const out = (stdout ?? '').trim();
        const errOut = (stderr ?? '').trim();
        if (!err) return resolve({ ok: true, code: 0, stdout: out, stderr: errOut });

        resolve({
          ok: false,
          // ENOENT and friends have no numeric exit code; report 127 the way a
          // shell would for "command not found".
          code: typeof err.code === 'number' ? err.code : 127,
          stdout: out,
          stderr: errOut || err.message,
        });
      },
    );
  });
}

/**
 * Run a command and return its stdout, or throw with the stderr attached.
 *
 * Use this where a failure is genuinely exceptional. Swallowing stderr is what
 * once turned a YouTrack parser error into a bare "update failed", so the
 * message always carries it.
 */
export async function shOrThrow(cmd, args = [], opts = {}) {
  const r = await sh(cmd, args, opts);
  if (!r.ok) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || `exit ${r.code}`}`);
  return r.stdout;
}

/** Run a command and JSON.parse its stdout, or return null. */
export async function shJson(cmd, args = [], opts = {}) {
  const r = await sh(cmd, args, opts);
  if (!r.ok) return { ok: false, error: r.stderr || `exit ${r.code}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (err) {
    return { ok: false, error: `could not parse output of ${cmd}: ${err.message}` };
  }
}

/**
 * Is `bin` on PATH?
 *
 * Spawns the binary rather than shelling out to `command -v`, so it needs no
 * shell and behaves the same on any platform. `--version` is the cheapest
 * universally-supported probe; ENOENT is the answer we actually care about.
 */
export async function has(bin) {
  const r = await sh(bin, ['--version'], { timeout: 10_000 });
  return r.code !== 127;
}
