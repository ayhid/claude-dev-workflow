/**
 * The issue-tracker abstraction: one core, one adapter per backend.
 *
 * The core — the commands, the sync reconciler, the skills — knows about
 * issues, ladder rungs and comments. It does not know what a YouTrack command
 * string looks like, or that GitHub has labels instead of states. Each backend
 * implements the interface below and nothing else reaches past it.
 *
 * ## The patterns, and why these ones
 *
 * **Adapter** per backend (`lib/youtrack.mjs`, `lib/github.mjs`), **Factory**
 * here (`makeProvider`), and a `capabilities` record so callers branch on what a
 * backend *can do* rather than on which one it is. `if (provider.name ===
 * 'github')` scattered through the commands is the thing this exists to prevent:
 * it makes every caller a place a third backend has to be taught about.
 *
 * There is deliberately no registry and no strategy layer. The payload is
 * copied into user projects as plain dependency-free source, so the core stays
 * small enough to read in one sitting.
 *
 * ## Determinism — the four rules every adapter must satisfy
 *
 * 1. **IO is injected.** An adapter receives its transport (`fetch`, or a
 *    command runner) and calls nothing else. That makes the whole layer
 *    testable offline with canned responses, and identical inputs produce
 *    identical outputs. `tests/provider.contract.mjs` relies on this.
 * 2. **No inference.** Every mapping — rung to state, rung to label, ID shape —
 *    comes from config. A missing mapping is an error naming the key to add,
 *    never a plausible-looking default. A guess that is right most of the time
 *    is worse than an error, because the times it is wrong are silent.
 * 3. **Writes read back.** `setState` reports the state it *found* after
 *    writing, never the one it was asked for, and applying the same rung twice
 *    converges. YouTrack's commands API returns 200 for commands it did not
 *    apply; rather than treat that as one backend's quirk, it is the contract.
 * 4. **Output is stable.** Adapters return sorted, fully-rendered values with no
 *    wall-clock in them, so the same inputs print the same bytes.
 *
 * ## State, and the representation of state
 *
 * A tracker that owns its own transitions has one copy of a ticket's state, and
 * `getState` / `setState` are the whole story. A backend that *models* the
 * ladder on top of something else has two, and they can disagree: GitHub closes
 * an issue by itself when a PR says `Closes #12`, so the issue reads as done
 * while still carrying the `in review` label nothing removed.
 *
 * That is not a transition — the state is already right — so it is not
 * `setState`'s job, and recording it as one would put a second close in the
 * metrics log for work that was closed once. It is its own read/write pair:
 * `checkRepresentation` (batched, like `getStates`) and `repairRepresentation`
 * (one issue, reads back, like `setState`).
 *
 * Every adapter implements both, and there is deliberately no capability flag
 * for it: a backend whose state IS its representation answers "nothing is
 * stale" and the caller needs no branch at all. A flag would only be a place to
 * forget the else.
 *
 * ## Enumerating the board
 *
 * `getStates` answers "where are these tickets?" for IDs the caller already
 * has, and every ID the core discovers comes from a branch name or a pull
 * request. That makes the whole tool blind in one direction: an issue nobody
 * has branched for contributes no ID, so nothing ever asks about it. `standup`
 * used to state that bound in its own header and then assert "nothing is
 * waiting on you" anyway — a claim about the whole board from a command that
 * never read the board.
 *
 * `listOpen` closes it, and it is a *different question* from `search`: search
 * takes keywords and is for dup-checking, where a fuzzy best-effort answer is
 * fine. This takes none and must return the open issues, so a caller can say
 * how many there are.
 *
 * Like the representation pair there is deliberately no capability flag. Every
 * tracker can enumerate its own open issues — that is what makes it a tracker —
 * so a flag would only be a place for a caller to forget the else.
 *
 * Adding a backend means one new file plus a `case` here, and passing
 * `tests/provider.contract.mjs` unchanged. If a change to the core is needed to
 * add a backend, the abstraction is wrong — fix it here rather than special-
 * casing the caller.
 */
import { UNKNOWN } from './sync.mjs';

export { UNKNOWN };
export { resolveRung } from './config.mjs';

/** Backends this build knows how to talk to. */
export const PROVIDERS = ['youtrack', 'github'];

/**
 * @typedef {Object} NormalizedIssue
 * @property {string}  id        'ABC-22' | '#123'
 * @property {string}  title
 * @property {string}  url
 * @property {string}  body      markdown; '' when empty
 * @property {string}  state     a ladder state, or UNKNOWN
 * @property {?string} assignee  login
 * @property {Array<{name: string, value: string}>} fields
 *   Already rendered to strings by the adapter — this is what keeps
 *   `scripts/cmd/fetch.mjs` free of any backend's value shapes.
 * @property {Array<{author: string, at: ?string, body: string}>} comments
 *   `at` is ISO-8601, so no adapter leaks an epoch or a locale format.
 * @property {{closed: boolean, closeReason: ?string, labels: string[]}} meta
 */

/**
 * @typedef {Object} RepairResult
 * @property {boolean} repaired  did anything actually change?
 * @property {string}  [state]   the state read back afterwards (rule 3)
 * @property {string}  [why]     what was stale, or why nothing was
 */

/**
 * @typedef {Object} OpenIssueRow
 * @property {string}  id     'ABC-22' | '#123'
 * @property {string}  title
 * @property {string}  state  a ladder state, or UNKNOWN
 * @property {string}  url
 *
 * A row of `listOpen`. `state` arrives resolved to a ladder rung by the
 * adapter, not to a backend's own vocabulary — an issue carrying no ladder
 * marking at all reads as the first rung, which is what "untouched" means and
 * is the case that was invisible before this existed.
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} types           can an issue carry a Type?
 * @property {boolean} priorities      can an issue carry an ordered Priority?
 * @property {boolean} assignee
 * @property {boolean} freeTextSearch  is dup-check exact, or best-effort?
 * @property {boolean} rawCommand      does a backend-native command DSL exist?
 */

/**
 * Build the provider for this project's config.
 *
 * IO is injected rather than imported so the adapters stay pure: pass `fetch`
 * for HTTP-backed trackers and `run` for CLI-backed ones. Both default to the
 * real thing, so nothing in production passes them.
 *
 * @param {object} config
 * @param {object} [io]
 * @param {typeof globalThis.fetch} [io.fetch]
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{ok: boolean, code: number, stdout: string, stderr: string}>} [io.run]
 * @param {NodeJS.ProcessEnv} [io.env]
 * @param {(message: string) => void} [io.onWarn]
 *   How an adapter reports something it swallowed. Every path that returns
 *   UNKNOWN calls this first — otherwise a 500 shows up as `?` in the sync
 *   table with the reason discarded.
 * @returns {Promise<{ok: true, provider: object} | {ok: false, error: string}>}
 */
export async function makeProvider(config, io = {}) {
  const name = config?.provider ?? 'youtrack';

  if (!PROVIDERS.includes(name)) {
    return {
      ok: false,
      error: `unknown provider "${name}" — set "provider" to one of: ${PROVIDERS.join(', ')}`,
    };
  }

  const deps = {
    config,
    env: io.env ?? process.env,
    onWarn: io.onWarn ?? ((m) => process.stderr.write(`${m}\n`)),
  };

  // Adapters load lazily: a YouTrack project should never pay to parse the
  // GitHub adapter, and the payload is plain source with no bundler to shake it.
  try {
    if (name === 'youtrack') {
      const { createYouTrackProvider } = await import('./youtrack.mjs');
      return createYouTrackProvider({ ...deps, fetch: io.fetch });
    }

    const { createGitHubProvider } = await import('./github.mjs');
    return createGitHubProvider({ ...deps, run: io.run });
  } catch (err) {
    // A missing adapter file is an incomplete install, not a config mistake.
    // Say which it is rather than surfacing a raw module resolution error.
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      return {
        ok: false,
        error: `the ${name} adapter is missing from this install — re-run the installer to repair it`,
      };
    }
    throw err;
  }
}
