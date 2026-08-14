/**
 * Fetch an issue and print it as clean markdown.
 *
 *   yt.mjs fetch ABC-22
 *
 * Comments are included in full: tickets migrated from another tracker often
 * carry their real requirements in the comment thread rather than the
 * description, so truncating them loses the acceptance criteria.
 */
import { getIssue } from '../../lib/youtrack.mjs';
import { context, must, UserError } from './common.mjs';

/** Render a custom-field value, whatever shape it arrives in. */
function renderValue(v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(renderValue).join(', ');
  if (typeof v === 'object') {
    if (typeof v.minutes === 'number') return `${v.minutes}m`;
    return v.name ?? v.fullName ?? v.login ?? v.presentation ?? v.text ?? '—';
  }
  return String(v);
}

const fieldValue = (issue, name) =>
  renderValue((issue.customFields ?? []).find((f) => f.name === name)?.value);

const timestamp = (ms) =>
  typeof ms === 'number'
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'unknown date';

export async function run(args) {
  const issueId = args[0];
  if (!issueId) throw new UserError('usage: yt.mjs fetch <ISSUE-ID>   (e.g. ABC-22)');

  const { config, token } = await context();
  const issue = must(await getIssue(config.baseUrl, token, issueId));

  const out = [
    `# ${issue.idReadable} — ${issue.summary || '(no title)'}`,
    '',
    `**State:** ${fieldValue(issue, 'State')}  |  **Assignee:** ${fieldValue(issue, 'Assignee')}`,
    '',
    '## Description',
    '',
    issue.description?.trim() ? issue.description : '_(no description)_',
    '',
    '## Fields',
    '',
  ];

  const others = (issue.customFields ?? [])
    .filter((f) => f.name !== 'State' && f.name !== 'Assignee')
    .map((f) => ({ name: f.name, value: renderValue(f.value) }))
    .filter((f) => f.value !== '—');

  out.push(
    ...(others.length
      ? others.map((f) => `- **${f.name}:** ${f.value}`)
      : ['_(no other fields set)_']),
  );

  const comments = issue.comments ?? [];
  out.push('', `## Comments (${comments.length})`, '');
  out.push(
    ...(comments.length
      ? comments.map(
          (c) => `### @${c.author?.login ?? 'unknown'} — ${timestamp(c.created)}\n\n${c.text ?? ''}\n`,
        )
      : ['_(no comments)_']),
  );

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
