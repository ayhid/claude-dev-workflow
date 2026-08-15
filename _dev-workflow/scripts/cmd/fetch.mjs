/**
 * Fetch an issue and print it as clean markdown.
 *
 *   dev.mjs fetch ABC-22
 *
 * Comments are included in full: tickets migrated from another tracker often
 * carry their real requirements in the comment thread rather than the
 * description, so truncating them loses the acceptance criteria.
 *
 * This renderer knows nothing about any backend. The adapter hands over a
 * NormalizedIssue whose values are already strings and whose timestamps are
 * already ISO-8601, so the same code prints a YouTrack issue and a GitHub one
 * identically — which is also what makes the output diffable across providers.
 */
import { context, must, UserError } from './common.mjs';

/** ISO-8601 → `YYYY-MM-DD HH:MM UTC`. */
const timestamp = (iso) =>
  typeof iso === 'string' && iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown date';

export async function run(args) {
  const issueId = args[0];
  if (!issueId) throw new UserError('usage: dev.mjs fetch <ISSUE-ID>   (e.g. ABC-22)');

  const { provider } = await context();
  const issue = must(await provider.getIssue(issueId));

  const out = [
    `# ${issue.id} — ${issue.title || '(no title)'}`,
    '',
    `**State:** ${issue.state}  |  **Assignee:** ${issue.assignee ?? '—'}`,
    '',
    '## Description',
    '',
    issue.body?.trim() ? issue.body : '_(no description)_',
    '',
    '## Fields',
    '',
  ];

  out.push(
    ...(issue.fields.length
      ? issue.fields.map((f) => `- **${f.name}:** ${f.value}`)
      : ['_(no other fields set)_']),
  );

  out.push('', `## Comments (${issue.comments.length})`, '');
  out.push(
    ...(issue.comments.length
      ? issue.comments.map((c) => `### @${c.author} — ${timestamp(c.at)}\n\n${c.body}\n`)
      : ['_(no comments)_']),
  );

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
