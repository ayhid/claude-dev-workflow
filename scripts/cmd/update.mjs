/**
 * Move an issue along the ladder, or comment on it.
 *
 *   dev.mjs update ABC-22 state start
 *   dev.mjs update ABC-22 state review "PR opened: <url>"
 *   dev.mjs update ABC-22 state done @/tmp/summary.md
 *   dev.mjs update ABC-22 comment "Implemented X and Y. Tests green."
 *   dev.mjs update ABC-22 raw "Type Bug Priority Major"     # youtrack only
 *
 * Callers name the *rung* — `start`, `review`, `done` — not the state. That is
 * what makes the command portable: the same line works whether the backend
 * moves a State field or swaps a label, and a skill no longer has to read the
 * configured state name out of `dev.mjs config` and interpolate it, which was a
 * whole class of "the session guessed the state name" failure.
 *
 * An explicit state is still accepted, but only if it is on the configured
 * ladder. It is rejected before anything is sent: on YouTrack an unrecognised
 * state is accepted with a 200 that changes nothing, so a typo used to look
 * exactly like success.
 *
 * The comment may be literal text or @path to read a file (@@ escapes a literal
 * '@'). The printed "State is now" line is read back after the write, never
 * echoed from the request.
 */
import { context, must, readArg, UserError } from './common.mjs';

const USAGE = `usage: dev.mjs update <ISSUE-ID> <VERB> [ARGS]

  state <start|review|done|"<ladder state>"> [COMMENT|@FILE]
  comment <TEXT|@FILE>
  raw "<command>" [COMMENT|@FILE]        backend-native, where supported`;

export async function run(args) {
  const [issue, verb, ...rest] = args;
  if (!issue || !verb) throw new UserError(USAGE);

  const { provider } = await context();

  if (verb === 'comment') {
    const text = rest[0] === undefined ? '' : readArg(rest[0], 'comment file');
    if (!text) throw new UserError('"comment" needs the comment text as the third argument');

    must(await provider.comment(issue, text));
    const state = await provider.getState(issue);
    process.stdout.write(
      `dev update: ${issue} — comment posted (${text.length} chars); State is: ${state}\n`,
    );
    return 0;
  }

  if (verb === 'state') {
    const [rung, rawComment] = rest;
    if (!rung) throw new UserError('"state" needs a rung: start, review, done, or a ladder state');
    const comment = rawComment === undefined ? '' : readArg(rawComment, 'comment file');

    const result = await provider.setState(issue, rung, comment || undefined);
    if (!result.ok) throw new UserError(result.error);

    process.stdout.write(`dev update: ${issue} — State is now: ${result.state}\n`);
    if (comment) process.stdout.write(`dev update: comment posted (${comment.length} chars)\n`);
    return 0;
  }

  if (verb === 'raw') {
    // The escape hatch for a backend's own command language. Guarded by the
    // capability rather than by the provider's name, so a future backend with a
    // DSL gets this for free and one without it gets a usable error.
    if (!provider.capabilities.rawCommand) {
      throw new UserError(
        `${provider.name} has no command language — use: dev.mjs update ${issue} state <start|review|done>`,
      );
    }
    const [command, rawComment] = rest;
    if (!command) throw new UserError('"raw" needs the command string');
    const comment = rawComment === undefined ? '' : readArg(rawComment, 'comment file');

    const result = await provider.raw(issue, command, comment || undefined);
    if (!result.ok) throw new UserError(result.error);

    process.stdout.write(
      `dev update: ${issue} — applied "${command}"; State is now: ${result.state}\n`,
    );
    if (comment) process.stdout.write(`dev update: comment posted (${comment.length} chars)\n`);
    return 0;
  }

  // A v1-shaped call: `update ABC-1 "State In Progress"`. The payload is
  // vendored per project, so a stale SKILL.md can outlive a fresh _dev-workflow/.
  // Translate it, say so once, and keep working.
  const legacyState = /^State\s+\{?(.+?)\}?$/.exec(verb);
  if (legacyState) {
    process.stderr.write(
      `dev update: "${verb}" is the old command form — use: dev.mjs update ${issue} state <start|review|done>\n`,
    );
    return run([issue, 'state', legacyState[1], ...rest]);
  }

  throw new UserError(`unknown verb "${verb}"\n\n${USAGE}`);
}
