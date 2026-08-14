/**
 * Apply a command to an issue, optionally posting a comment.
 *
 *   yt.mjs update ABC-22 "State In Progress"
 *   yt.mjs update ABC-22 "State Staging" "Implemented X and Y. Tests green."
 *   yt.mjs update ABC-22 comment @/tmp/comment.md
 *
 * The comment may be literal text or @path to read a file (@@ escapes a literal
 * '@'). The printed "State is now" line is the real result — the commands API
 * returns 200 for commands it did not apply, so the exit code proves nothing.
 */
import { applyCommand, getState, postComment } from '../../lib/youtrack.mjs';
import { context, must, readArg, UserError } from './common.mjs';

export async function run(args) {
  const [issue, command, rawComment] = args;
  if (!issue || !command) {
    throw new UserError('usage: yt.mjs update <ISSUE-ID> <COMMAND> [COMMENT|@FILE]');
  }

  const comment = rawComment === undefined ? '' : readArg(rawComment, 'comment file');
  const { config, token } = await context();

  // `comment` is not a YouTrack command — the commands API would 400 on it — so
  // comment-only updates go to the dedicated endpoint.
  if (command === 'comment') {
    if (!comment) throw new UserError('"comment" needs the comment text as the third argument');
    must(await postComment(config.baseUrl, token, issue, comment));
    const state = await getState(config.baseUrl, token, issue);
    process.stdout.write(
      `yt update: ${issue} — comment posted (${comment.length} chars); State is: ${state}\n`,
    );
    return 0;
  }

  const result = await applyCommand(config.baseUrl, token, issue, command, comment || undefined);
  if (!result.ok) throw new UserError(result.error);

  process.stdout.write(
    `yt update: ${issue} — applied "${command}"; State is now: ${result.state}\n`,
  );
  if (comment) process.stdout.write(`yt update: comment posted (${comment.length} chars)\n`);
  return 0;
}
