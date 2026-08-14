/**
 * Create an issue and print its ID, or search for likely duplicates.
 *
 *   yt.mjs create "<summary>" "<description>" [TYPE] [PRIORITY]
 *   yt.mjs create "Router: 500 on nested slug" @/tmp/body.md Bug Major
 *   yt.mjs create --dup-check "redirect 500 slug"
 *
 * On success **only the issue ID goes to stdout**, so callers can capture it;
 * everything else goes to stderr.
 */
import { commandFor, createIssue, request, resolveProjectId, searchIssues, typeAndPriority } from '../../lib/youtrack.mjs';
import { context, must, readArg, UserError } from './common.mjs';

async function dupCheck(config, token, keywords) {
  const issues = must(await searchIssues(config.baseUrl, token, config.project, keywords));
  if (!issues.length) {
    process.stdout.write('no open issues matched\n');
    return 0;
  }
  for (const i of issues) {
    process.stdout.write(`${i.idReadable}\t${i.summary || '(no title)'}\n`);
  }
  return 0;
}

export async function run(args) {
  if (args[0] === '--dup-check') {
    const keywords = args[1];
    if (!keywords) throw new UserError('usage: yt.mjs create --dup-check "<keywords>"');
    const { config, token } = await context({ requireProject: true });
    return dupCheck(config, token, keywords);
  }

  const [summary, rawDescription, type = 'Bug', priority = ''] = args;
  if (!summary || rawDescription === undefined) {
    throw new UserError('usage: yt.mjs create "<summary>" "<description>" [TYPE] [PRIORITY]');
  }

  const description = readArg(rawDescription, 'description file');
  const { config, token } = await context({ requireProject: true });

  const projectId = must(await resolveProjectId(config.baseUrl, token, config.project, config.projectId));
  const issue = must(await createIssue(config.baseUrl, token, projectId, summary, description));

  // Custom field values via the issues endpoint need per-project field ids; the
  // commands API takes them by name. The issue already exists by this point, so
  // a failure here warns rather than throwing — losing the ID would be worse
  // than an unset field.
  const query = commandFor({ Type: type, Priority: priority });
  if (query) {
    const applied = await request(config.baseUrl, token, 'api/commands', {
      method: 'POST',
      body: { query, issues: [{ idReadable: issue }] },
    });

    if (!applied.ok) {
      process.stderr.write(
        `yt create: ${issue} was created, but applying '${query}' failed — ${applied.error}\n` +
          `yt create: set Type/Priority by hand\n`,
      );
    } else {
      // 200 does not mean applied. Read back what actually stuck.
      process.stderr.write(
        `yt create: created ${issue} (${await typeAndPriority(config.baseUrl, token, issue)})\n`,
      );
    }
  }

  process.stdout.write(`${issue}\n`);
  return 0;
}
