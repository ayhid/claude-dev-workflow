/**
 * Branch names: rendering them, and reading an issue ID back out of one.
 *
 * Pure — no I/O, no git. `lib/vcs.mjs` runs the commands; this decides what to
 * call things. Keeping the two apart is what makes the naming rules testable
 * without a repository, the same way `lib/sync.mjs` holds the reconciler's
 * decisions and `scripts/cmd/sync.mjs` holds its I/O.
 *
 * The pattern is config (`branch.pattern`), so every token is optional: a
 * project that pins the pre-gitflow `<ID>-<slug>` keeps byte-identical names
 * after this file exists, because a token that is not in the pattern is never
 * rendered.
 */
import { idSyntaxFor } from './issueid.mjs';

/**
 * Characters git-check-ref-format rejects outright, plus the ones that are only
 * legal in positions we cannot guarantee. Spelled with escapes rather than
 * literals because half of them are unprintable and would not survive an edit.
 */
const ILLEGAL_REF_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/g;

/** Words a slug should never *end* on, once the word cap has truncated it. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'it', 'with', 'from',
]);

/** The combining marks NFKD splits off, so "déjà" folds to "deja", not "dj". */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * The issue ID as it may appear **inside a ref**.
 *
 * GitHub IDs are written `#42`, and while git would accept `#` in a branch name
 * it is a comment character in enough config files, shells and CI expressions
 * that putting one there is a trap. The number alone identifies the issue once
 * the repo is pinned by config — which the GitHub adapter already requires —
 * so that is what goes in the ref.
 */
export function refIdFor(config, id) {
  const raw = String(id ?? '').trim();
  if ((config?.provider ?? 'youtrack') !== 'github') return raw;
  return /(\d+)\s*$/.exec(raw)?.[1] ?? raw;
}

/**
 * A ref segment git will actually accept.
 *
 * git-check-ref-format rejects more than people expect, and the inputs here are
 * issue titles: real ones contain `~`, `:`, `?`, `[`, `@{`, doubled dots and
 * trailing dots. Sanitising at render time turns a class of "branch creation
 * failed" into a name that is merely less pretty.
 */
export function safeRefSegment(text) {
  let s = String(text ?? '')
    .replace(ILLEGAL_REF_CHARS, '-')
    // `@{` is illegal as a sequence; a lone `@` is fine.
    .replace(/@\{/g, '-')
    // `..` is illegal; collapse any run of dots to one.
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-');

  // No leading or trailing `.`, `-` or `/`, and no `.lock` suffix.
  s = s.replace(/^[./-]+/, '').replace(/[./-]+$/, '');
  if (s.endsWith('.lock')) s = s.slice(0, -'.lock'.length).replace(/[./-]+$/, '');
  return s;
}

/**
 * Kebab-case slug from free text, capped at `maxWords` words.
 *
 * The cap matters: an issue title is a sentence, and an eighty-character branch
 * name is unusable at a prompt. Three to five words is what the skill has asked
 * for in prose since the beginning — this is that rule, executable.
 */
export function slugify(text, { maxWords = 5 } = {}) {
  const words = String(text ?? '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Truncating a sentence lands on a dangling article surprisingly often
  // ("...silently-discards-an"), which reads like the name was cut off — because
  // it was. Only trailing ones are dropped: "the" in the middle is doing work.
  const trimmed = words.slice(0, maxWords);
  while (trimmed.length > 1 && STOPWORDS.has(trimmed[trimmed.length - 1])) trimmed.pop();

  return trimmed.join('-');
}

/**
 * Render `branch.pattern` for one issue.
 *
 * Tokens: `<type>` (the branch type, see `resolveBranchType` in lib/config.mjs),
 * `<ID>` (ref-safe, see `refIdFor`) and `<slug>`. A token the pattern does not
 * contain is simply never rendered, which is what keeps a pre-gitflow
 * `<ID>-<slug>` producing exactly the names it always did.
 *
 * @param {object} config
 * @param {{id: string, type?: string, title?: string, slug?: string}} issue
 * @returns {{ok: true, branch: string} | {ok: false, error: string}}
 */
export function renderBranch(config, { id, type, title, slug } = {}) {
  const pattern = config?.branch?.pattern ?? '<type>/<ID>-<slug>';
  const refId = refIdFor(config, id);

  if (pattern.includes('<ID>') && !refId) {
    return { ok: false, error: 'no issue ID to render into the branch name' };
  }
  if (pattern.includes('<type>') && !type) {
    return { ok: false, error: 'branch.pattern contains <type> but no branch type was resolved' };
  }

  const parts = {
    '<type>': safeRefSegment(type ?? ''),
    '<ID>': safeRefSegment(refId),
    '<slug>': safeRefSegment(slug ?? slugify(title)),
  };

  let branch = pattern;
  for (const [token, value] of Object.entries(parts)) branch = branch.split(token).join(value);

  // An empty slug leaves `<ID>-` behind, an empty type a leading `/`. Tidy the
  // seams the substitution created, without touching separators the pattern
  // asked for between two values that are both present.
  branch = branch
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[/-]+/, '')
    .replace(/[/-]+$/, '');

  if (!branch) return { ok: false, error: `branch.pattern "${pattern}" rendered an empty name` };
  return { ok: true, branch };
}

/**
 * The issue ID a branch name refers to, or null.
 *
 * Not `extractIssueIds`: that scans prose, where a GitHub ID is written `#42`,
 * and a branch never contains a `#` (see `refIdFor`). Scanning a branch with the
 * prose syntax is why `/dev-done` could never infer an ID on a GitHub project.
 */
export function issueIdFromBranch(config, branch) {
  const name = String(branch ?? '').trim();
  if (!name) return null;

  if ((config?.provider ?? 'youtrack') === 'github') {
    // Drop any `<type>/` prefix, then take a leading run of digits. Anchoring to
    // the start is deliberate: `feat/42-fix-500-error` is issue 42, not 500.
    const tail = name.slice(name.lastIndexOf('/') + 1);
    const m = /^#?(\d+)(?:[^0-9]|$)/.exec(tail);
    return m ? `#${m[1]}` : null;
  }

  const { regex } = idSyntaxFor(config);
  const scan = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  return name.match(scan)?.[0] ?? null;
}

/**
 * The issue's type, as one of the project's `issueTypes`, or null.
 *
 * Two config-declared sources, tried in order, and no provider-name check
 * between them — a backend that renders a `Type` field answers on the first, a
 * backend that models types as labels answers on the second through the very
 * mapping `github.labels.type` already has to declare. Neither is a guess: a
 * backend that declares nothing returns null, and the caller falls back to the
 * configured `branch.fallbackType` rather than inventing one (rule 2).
 */
export function issueTypeOf(config, issue) {
  const field = (issue?.fields ?? []).find((f) => String(f?.name).toLowerCase() === 'type');
  if (field?.value) return field.value;

  const byLabel = config?.github?.labels?.type ?? {};
  const labels = new Set(issue?.meta?.labels ?? []);
  for (const [type, label] of Object.entries(byLabel)) if (labels.has(label)) return type;

  return null;
}

/**
 * Where a worktree for `branch` lives.
 *
 * `branch.worktreeDir` is relative to the repo it belongs to, so a worktree sits
 * inside the project root and `loadConfig`'s upward walk still finds
 * `.dev-workflow.json` from inside it. A sibling or central directory would
 * resolve no config at all without an env var set.
 *
 * The branch's `/` separators are flattened to `-`: nesting the checkout by
 * branch type would make `.worktrees/feat` both a directory of worktrees and,
 * the moment someone branches `feat` itself, a worktree.
 */
export function worktreePathFor(config, { repoDir, branch }) {
  const dir = config?.branch?.worktreeDir ?? '.worktrees';
  const leaf = String(branch ?? '').split('/').join('-');
  return `${repoDir}/${dir}/${leaf}`;
}
