/**
 * The `.dev-workflow.json` the wizard writes, as a pure function of the answers.
 *
 * This lived inline in `bin/install.mjs` until the wizard learned a second
 * tracker. A top-level-await script full of prompts cannot be run without a
 * TTY, so nothing asserted what the installer actually emitted — and the shape
 * a GitHub project needs is not a matter of taste but of what
 * `createGitHubProvider` refuses to start without.
 *
 * Pulling it out makes that testable: `tests/install-config.test.mjs` feeds the
 * output straight to `makeProvider`, so a wizard that emits a config the adapter
 * rejects fails in CI rather than on somebody's first `/dev-task`.
 *
 * Nothing here prompts, reads a file or shells out. Answers in, JSON shape out.
 */

/**
 * @param {object} answers
 * @param {'youtrack'|'github'} answers.provider
 * @param {object} answers.identity
 *   `{baseUrl, project, projectId?, tokenOpRef?}` for YouTrack,
 *   `{github: {repo, labels, type?}}` for GitHub. Spread verbatim.
 * @param {{start: string, review: string, done: string, abandon: ?string, ladder: string[]}} answers.states
 * @returns {object} the config, ready to `JSON.stringify`
 */
export function buildConfig({
  provider,
  identity,
  language,
  states,
  branchMode,
  base,
  worktreeDir = null,
  useTypedBranches,
  branchTypes = {},
  deliveryMode,
  deliveryRemote = null,
  position,
  requireType,
  enforce,
  commitTypes = null,
  noTicketEscape = 'chore(no-ticket)',
  issueTypes = [],
  priorities = null,
  defaultPriority = null,
  reviewer = '',
  repos = [],
  notes = null,
  typeLabels = null,
}) {
  const idPattern = position === 'prefix' ? '<ID> type(scope): description' : 'type(scope): description (<ID>)';

  // `#123` means a different issue in every repository, so a project spanning
  // several must say which one holds them — the adapter refuses otherwise. This
  // is the answer to "which repository holds the issues?", recorded, not a guess:
  // the wizard asked that question in those words.
  const github = identity?.github;
  const multiRepo = repos.length > 1;
  const resolvedIdentity = github
    ? {
        github: {
          ...github,
          ...(multiRepo && !github.issuesRepo ? { issuesRepo: github.repo } : {}),
          // Which label means which issue *type*. It lives beside the ladder
          // labels because it is the same kind of mapping, and it is what
          // `capabilities.types` is read off — without it GitHub reports no
          // types at all, and every typed branch renders the fallback.
          labels: { ...github.labels, ...(typeLabels ? { type: typeLabels } : {}) },
        },
      }
    : identity;

  return {
    // Written explicitly rather than left to the default, so the file says
    // which tracker it is for even when every other key happens to match.
    provider,
    ...resolvedIdentity,
    language,
    states: {
      start: states.start,
      review: states.review,
      done: states.done,
      // No default, and never invented: `abandon` walks a ticket backwards, and
      // it is the one move nothing else in the tool would notice was wrong.
      ...(states.abandon ? { abandon: states.abandon } : {}),
      ladder: states.ladder ?? [],
    },
    branch: {
      pattern: useTypedBranches ? '<type>/<ID>-<slug>' : '<ID>-<slug>',
      base,
      mode: branchMode,
      ...(worktreeDir ? { worktreeDir } : {}),
      // A mapping of issue type onto *commit* type: the branch and the commits
      // on it share one vocabulary, so a value outside `commit.types` is
      // refused at branch time. Only written when branches carry a type at all.
      ...(useTypedBranches && Object.keys(branchTypes).length ? { types: branchTypes } : {}),
    },
    delivery: {
      mode: deliveryMode,
      ...(deliveryRemote ? { remote: deliveryRemote } : {}),
    },
    commit: {
      pattern: requireType ? idPattern : position === 'prefix' ? '<ID>: description' : 'description (<ID>)',
      position,
      noTicketEscape,
      ...(commitTypes?.length ? { types: commitTypes } : {}),
      ...(requireType ? {} : { requireType: false }),
      ...(enforce ? {} : { enforce: false }),
    },
    // Omitted entirely for a tracker that has no such concept, rather than
    // written as a list nothing will ever read: GitHub reports
    // `capabilities.priorities: false`, and its types exist only if the project
    // mapped them onto labels.
    ...(issueTypes?.length ? { issueTypes } : {}),
    ...(priorities?.length ? { priorities } : {}),
    ...(defaultPriority ? { defaultPriority } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(repos.length ? { repos } : {}),
    ...(notes ? { notes } : {}),
  };
}

/**
 * The default priority to propose: the caller's previous choice if it still
 * exists, else the "normal"-looking rung, else the middle of the list.
 */
export function pickDefaultPriority(priorities, previous) {
  if (!priorities?.length) return null;
  if (priorities.includes(previous)) return previous;
  return priorities.find((v) => /normal|medium/i.test(v)) ?? priorities[Math.floor(priorities.length / 2)] ?? 'Normal';
}

/**
 * Which tracker to offer as the wizard's default answer.
 *
 * An existing config outranks the remote, and outranks it even when it predates
 * the `provider` key: a `baseUrl` is a YouTrack project however the code is
 * hosted, and most YouTrack projects live in a repo on GitHub. Reading the
 * remote first would greet everyone reconfiguring one with an offer to convert
 * it.
 *
 * A proposal either way — the question is still asked.
 */
export function proposeProvider({ existing = null, detectedSlug = null } = {}) {
  if (existing?.provider) return existing.provider;
  if (existing?.baseUrl) return 'youtrack';
  if (existing?.github?.repo || detectedSlug) return 'github';
  return 'youtrack';
}
