/**
 * Apply a state change or a comment to an issue.
 *
 *   dev.mjs update ABC-22 "State In Progress"
 *   dev.mjs update ABC-22 comment @/tmp/comment.md
 *
 * The comment may be literal text or @path to read a file (@@ escapes a literal
 * '@'). The printed "State is now" line is the real result: it is read back
 * after the write, never echoed from the request, because a backend can accept
 * a write and apply nothing.
 */
import { context, must, readArg, UserError } from './common.mjs';

export async function run(args) {
  const [issue, command, rawComment] = args;
  if (!issue || !command) {
    throw new UserError('usage: dev.mjs update <ISSUE-ID> <COMMAND> [COMMENT|@FILE]');
  }

  const comment = rawComment === undefined ? '' : readArg(rawComment, 'comment file');
  const { provider } = await context();

  if (command === 'comment') {
    if (!comment) throw new UserError('"comment" needs the comment text as the third argument');
    must(await provider.comment(issue, comment));
    const state = await provider.getState(issue);
    process.stdout.write(
      `dev update: ${issue} — comment posted (${comment.length} chars); State is: ${state}\n`,
    );
    return 0;
  }

  // A backend-native command string, e.g. YouTrack's `State In Progress`.
  // Providers that have no command DSL reject it rather than guessing.
  if (!provider.capabilities.rawCommand) {
    throw new UserError(
      `${provider.name} has no command language — use: dev.mjs update ${issue} state <start|review|done>`,
    );
  }

  const result = await provider.raw(issue, command, comment || undefined);
  if (!result.ok) throw new UserError(result.error);

  process.stdout.write(
    `dev update: ${issue} — applied "${command}"; State is now: ${result.state}\n`,
  );
  if (comment) process.stdout.write(`dev update: comment posted (${comment.length} chars)\n`);
  return 0;
}
