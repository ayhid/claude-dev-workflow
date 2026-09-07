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
import { canonicalId } from '../../lib/issueid.mjs';
import { context, must, UserError } from './common.mjs';

/** ISO-8601 → `YYYY-MM-DD HH:MM UTC`. */
const timestamp = (iso) =>
  typeof iso === 'string' && iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown date';

export async function run(args) {
  const rawId = args[0];
  if (!rawId) throw new UserError('usage: dev.mjs fetch <ISSUE-ID>   (e.g. ABC-22)');

  const { config, provider } = await context();
  // One spelling from here on — see canonicalId in lib/issueid.mjs (#43).
  const issueId = canonicalId(config, rawId);
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

  // The work units a parent was split into (#103), so /dev-split and /dev-done
  // see the split without a second command. A parent with none prints nothing
  // extra, and a lookup that fails must not fail the fetch — the issue itself
  // was read fine, and that is what was asked for.
  const children = await provider.children(issueId);
  if (!children.ok) {
    process.stderr.write(`dev fetch: could not list sub-issues: ${children.error}\n`);
  } else if (children.data.length) {
    out.push('', `## Sub-issues (${children.data.length})`, '');
    out.push(...children.data.map((c) => `- ${c.id} — ${c.title}`));
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
