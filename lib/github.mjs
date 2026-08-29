/**
 * The GitHub Issues adapter.
 *
 * Drives the `gh` CLI rather than the REST API, so authentication is whatever
 * the user already has — no token to store, no credential path of our own. The
 * runner is injected (`run`), which keeps this file pure and lets the whole
 * adapter be tested offline against recorded argv and canned stdout.
 *
 * Every call goes out as an argument array. Never build a shell string: an
 * issue title containing a quote or a `$` would otherwise be a command
 * injection, and titles come from the outside world.
 *
 * ## Where GitHub genuinely differs from a state-machine tracker
 *
 * GitHub has no state field. An issue is open or closed, and everything else is
 * a label. So the ladder is *modelled* with labels, and — rule 2 — the mapping
 * is required config rather than a guess: a project must declare
 * `github.labels`, because inferring that the rung `In Review` means a label
 * literally called `In Review` is right often enough to be dangerous and wrong
 * silently.
 *
 * Two mismatches cannot be designed away, only surfaced:
 *
 *   - `#12` is unique per repository, not globally. A multi-repo project must
 *     name `github.issuesRepo`, or `#12` is ambiguous.
 *   - GitHub closes issues by itself when a PR says `Fixes #12`, so an issue can
 *     jump from backlog to done without ever passing through review. The
 *     reconciler reports that as `ahead`, which is correct but means the review
 *     rung is inherently less reliable here than on a tracker that owns its own
 *     transitions.
 */
import { sh } from './sh.mjs';
import { idSyntaxFor } from './issueid.mjs';
import { ladderOf, rankOf, resolveRung } from './config.mjs';
import { UNKNOWN } from './sync.mjs';

/**
 * `gh` versions below this omit `stateReason` from `issue view --json`.
 *
 * Without it every closed issue reads as "done", which would silently mark
 * declined work as shipped — so this gate is not optional.
 *
 * Exported because the installer checks the same floor before writing a GitHub
 * config. Two spellings of one version number is a drift waiting to happen.
 */
export const MIN_GH = [2, 28, 0];

export const parseVersion = (text) => {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export const atLeast = (got, want) => {
  for (let i = 0; i < want.length; i += 1) {
    if ((got[i] ?? 0) > want[i]) return true;
    if ((got[i] ?? 0) < want[i]) return false;
  }
  return true;
};

/** The issue number from `#12`, `12`, or `acme/api#12`. */
const numberOf = (id) => {
  const m = /(\d+)\s*$/.exec(String(id));
  return m ? m[1] : null;
};

/**
 * Build the GitHub provider.
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {Function} [opts.run]     injected command runner; defaults to lib/sh.mjs
 * @param {Function} [opts.onWarn]
 */
export function createGitHubProvider({ config, run = sh, onWarn }) {
  const gh = config?.github ?? {};
  const repo = gh.issuesRepo || gh.repo;

  if (!repo) {
    return {
      ok: false,
      error: 'no GitHub repository configured — add "github": { "repo": "owner/name" }',
    };
  }

  // `#12` means a different issue in every repository, and this tool supports
  // multi-repo projects. Rather than guess which repo an ID belongs to, require
  // the project to say where its issues live.
  if ((config.repos?.length ?? 0) > 1 && !gh.issuesRepo) {
    return {
      ok: false,
      error:
        'this project has several repos, so "#123" is ambiguous — add "github": { "issuesRepo": "owner/name" } to say which repository holds the issues',
    };
  }

  const ladder = ladderOf(config);
  const labels = gh.labels ?? {};

  // Rule 2, enforced at construction rather than at the first write: a rung
  // with no label would otherwise fail halfway through a `sync --apply`.
  const mappable = ladder.slice(1); // ladder[0] is the unlabelled rung, by definition
  const missing = mappable.filter((rung) => !labels[rung]);
  if (missing.length) {
    return {
      ok: false,
      error:
        `no GitHub label configured for: ${missing.join(', ')} — add them to "github": { "labels": { ... } }. ` +
        `The first ladder rung ("${ladder[0]}") needs none: it is what an issue with no ladder label is.`,
    };
  }

  const labelFor = (state) => labels[state] ?? null;
  const stateForLabel = (name) => mappable.find((rung) => labels[rung] === name) ?? null;

  const call = (args, opts) => run('gh', args, opts);

  /** Map one `gh` issue object onto a ladder state. */
  const stateOf = (issue) => {
    if (!issue) return UNKNOWN;

    // Closed as "not planned" is GitHub's Won't Fix. It is deliberately NOT
    // mapped onto the ladder: the reconciler leaves off-ladder issues alone,
    // which is exactly right for work that was declined.
    if (issue.state === 'CLOSED' && issue.stateReason === 'NOT_PLANNED') return 'not planned';

    // Closed beats labels. An issue closed while still carrying `in progress`
    // is stale labelling, not a contradiction to resolve.
    if (issue.state === 'CLOSED') return config.states.done;

    // Open: the highest ladder label present. Lower stale labels are common,
    // because nothing forces them to be removed.
    const present = (issue.labels ?? [])
      .map((l) => stateForLabel(typeof l === 'string' ? l : l?.name))
      .filter(Boolean);
    if (present.length) {
      return present.reduce((a, b) => (rankOf(config, b) > rankOf(config, a) ? b : a));
    }

    // No ladder label at all. This is why an explicit ladder is required: the
    // first rung is what "untouched" means, and guessing it would report every
    // backlog issue as in progress.
    return ladder[0];
  };

  /**
   * The ladder labels actually on an issue, sorted so the reason string a
   * repair prints is the same bytes on every run (rule 4).
   */
  const ladderLabelsOn = (issue) =>
    (issue?.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter((name) => name && stateForLabel(name))
      .sort();

  /**
   * Why this issue's labels contradict the state it is in, or null.
   *
   * The gap this closes: `stateOf` above is right to let a close beat a stale
   * label, but that answer erases the only signal that a repair is needed. The
   * decision and the disagreement are two facts, so they are two functions.
   *
   * Two silences are deliberate, and both were properties of the CI step this
   * replaces. An off-ladder issue — closed as not planned, or unreadable — is
   * somebody's decision, not drift. An issue carrying NO ladder label is not
   * backfilled: an imported or bot-filed issue never entered the ladder, and
   * labelling it `done` because it happens to be closed would invent history.
   */
  const driftOf = (issue) => {
    const state = stateOf(issue);
    if (state === UNKNOWN || rankOf(config, state) < 0) return null;

    const present = ladderLabelsOn(issue);
    if (present.length === 0) return null;

    const wanted = labelFor(state);
    // Only the labels that disagree. Naming the correct one alongside them
    // would make the reason read as if it were part of the problem.
    const stale = present.filter((l) => l !== wanted);
    if (stale.length === 0) return null;

    const shown = stale.map((l) => `"${l}"`).join(', ');
    return `labelled ${shown}, but the issue is ${state}`;
  };

  /**
   * The `issue edit` argv for a set of label changes, or null when there are
   * none to make. Shared so `setState` and `repairRepresentation` cannot
   * disagree about how a label edit is spelled.
   *
   * The two pass different sets on purpose. `setState` has not read the issue,
   * so it drops every sibling rung blind; the repair has just read it, so it
   * names only labels it saw — which is also the safer argv, since `gh` fails
   * the whole edit on a label this repository does not have.
   */
  const labelEditArgs = (n, { add = [], remove = [] }) => {
    const edits = [];
    for (const l of add) edits.push('--add-label', l);
    for (const l of remove) edits.push('--remove-label', l);
    return edits.length ? ['issue', 'edit', n, '-R', repo, ...edits] : null;
  };

  /**
   * Refuse rather than create. A label this repository does not have is a
   * visible, permanent addition to somebody's repo, and it needs consent.
   */
  const ensureLabel = async (wanted) => {
    if (!wanted) return { ok: true };
    const known = await json(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name']);
    if (!known.ok) return known;
    const names = new Set((known.data ?? []).map((l) => l.name));
    if (names.has(wanted)) return { ok: true };
    return {
      ok: false,
      error: `${repo} has no label "${wanted}" — create it with: gh label create "${wanted}" -R ${repo}`,
    };
  };

  /**
   * How many issues one GraphQL query asks about.
   *
   * Aliased `issue(number:)` fields cost one point each, so this is well inside
   * anything GitHub rate-limits; it is a bound on query size, not a tuning knob.
   */
  const GRAPHQL_BATCH = 50;

  /** The GraphQL selection matching exactly what `stateOf` and `driftOf` read. */
  const ISSUE_GQL = 'number state stateReason labels(first: 100) { nodes { name } }';

  /**
   * One GraphQL issue node in the shape the `--json` reads produce, so
   * `stateOf` and `driftOf` never learn there are two transports.
   */
  const fromGraphql = (node) => ({
    number: node.number,
    state: node.state,
    stateReason: node.stateReason,
    labels: (node.labels?.nodes ?? []).filter(Boolean).map((l) => ({ name: l.name })),
  });

  /**
   * The raw issue objects behind `ids`, keyed by number, in ONE call per 50.
   *
   * Shared by `getStates` and `checkRepresentation` because they ask two
   * questions of the same read, and because per-issue here is a process spawn
   * plus a round trip each.
   *
   * Why GraphQL rather than `issue list`: the numbers asked about must be the
   * numbers answered. `gh issue list --limit N` returns the N most recently
   * *created* issues, which is a different set — so on any repository with more
   * issues than the window, an older one silently fell out, `getStates` reported
   * UNKNOWN, and the reconciler skipped it saying nothing. That is the failure
   * this whole path exists to fix, reappearing one layer down, and it was
   * likeliest in exactly the case that needs it most: `--deep --since 1y`,
   * hunting a label stranded long ago. Aliased lookups have no window.
   */
  const listByNumber = async (ids) => {
    const gate = await ensureGh();
    if (!gate.ok) return gate;

    const byNumber = new Map();
    const numbers = [...new Set((ids ?? []).map(numberOf).filter(Boolean))];
    if (!numbers.length) return { ok: true, byNumber };

    const [owner, name] = repo.split('/');

    for (let i = 0; i < numbers.length; i += GRAPHQL_BATCH) {
      const chunk = numbers.slice(i, i + GRAPHQL_BATCH);
      // `numberOf` has already proved every one of these is digits, which is
      // what makes them safe to splice into the query text. Everything that is
      // not — owner and name — goes through a variable.
      const fields = chunk.map((n) => `i${n}: issue(number: ${n}) { ${ISSUE_GQL} }`).join('\n');
      const r = await call([
        'api', 'graphql',
        '-f', `owner=${owner}`,
        '-f', `name=${name}`,
        '-f', `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      ]);

      // A number that does not exist makes GitHub answer with the issues that
      // do plus a NOT_FOUND in `errors`, and `gh` exits non-zero on any `errors`
      // at all. Reading the body regardless is what keeps one deleted issue from
      // blanking the other forty-nine; an alias that is genuinely absent stays
      // absent, which is the UNKNOWN the callers already handle.
      let repository = null;
      try {
        repository = JSON.parse(r.stdout || 'null')?.data?.repository ?? null;
      } catch {
        repository = null;
      }
      if (!repository) {
        return { ok: false, error: r.ok ? `could not read ${repo}` : r.stderr || `gh exited ${r.code}` };
      }

      for (const n of chunk) {
        const node = repository[`i${n}`];
        if (node) byNumber.set(String(node.number ?? n), fromGraphql(node));
      }
    }

    return { ok: true, byNumber };
  };

  let preflight = null;
  /** Check `gh` exists, is new enough, and is authenticated. Once per process. */
  const ensureGh = async () => {
    if (preflight) return preflight;
    preflight = (async () => {
      const v = await call(['--version']);
      if (!v.ok) {
        return {
          ok: false,
          error: 'the GitHub CLI (gh) is required for provider "github" — see https://cli.github.com',
        };
      }
      const got = parseVersion(v.stdout);
      if (got && !atLeast(got, MIN_GH)) {
        return {
          ok: false,
          error: `gh ${got.join('.')} is too old — ${MIN_GH.join('.')} or newer is needed to tell "closed as completed" from "closed as not planned"`,
        };
      }
      const auth = await call(['auth', 'status']);
      if (!auth.ok) return { ok: false, error: `gh is not authenticated — run: gh auth login` };
      return { ok: true };
    })();
    return preflight;
  };

  const json = async (args) => {
    const gate = await ensureGh();
    if (!gate.ok) return gate;
    const r = await call(args);
    if (!r.ok) return { ok: false, error: r.stderr || `gh exited ${r.code}` };
    try {
      return { ok: true, data: JSON.parse(r.stdout || 'null') };
    } catch (err) {
      return { ok: false, error: `could not parse gh output: ${err.message}` };
    }
  };

  const ISSUE_JSON = 'number,title,body,state,stateReason,url,labels,assignees,author,createdAt,comments';

  const provider = {
    name: 'github',
    syntax: idSyntaxFor(config),
    capabilities: {
      types: Boolean(gh.labels?.type),
      // GitHub has no ordered priority concept at all. Saying so lets callers
      // warn once instead of silently dropping the value.
      priorities: false,
      assignee: true,
      // Issue search is fuzzy and eventually consistent, unlike a tracker query.
      freeTextSearch: true,
      rawCommand: false,
    },

    async whoami() {
      const gate = await ensureGh();
      if (!gate.ok) return gate;
      const r = await call(['api', 'user', '--jq', '.login']);
      if (!r.ok) return { ok: false, error: r.stderr || 'could not read the authenticated user' };
      return { ok: true, data: r.stdout.trim() };
    },

    async resolveProject() {
      const r = await json(['repo', 'view', repo, '--json', 'nameWithOwner,name,url,viewerPermission']);
      if (!r.ok) return r;
      const d = r.data ?? {};
      if (d.viewerPermission === 'READ') {
        return { ok: false, error: `you have read-only access to ${repo} — the workflow needs write` };
      }
      return { ok: true, data: { id: d.nameWithOwner, key: d.nameWithOwner, name: d.name, url: d.url } };
    },

    async getIssue(id) {
      const n = numberOf(id);
      if (!n) return { ok: false, error: `"${id}" is not a GitHub issue reference (expected ${provider.syntax.sample})` };

      const r = await json(['issue', 'view', n, '-R', repo, '--json', ISSUE_JSON]);
      if (!r.ok) return r;
      return { ok: true, data: normalizeIssue(r.data, { repo, stateOf }) };
    },

    async getState(id) {
      const n = numberOf(id);
      if (!n) {
        onWarn?.(`"${id}" is not a GitHub issue reference`);
        return UNKNOWN;
      }
      const r = await json(['issue', 'view', n, '-R', repo, '--json', 'state,stateReason,labels']);
      if (!r.ok) {
        onWarn?.(`could not read the state of ${id}: ${r.error}`);
        return UNKNOWN;
      }
      return stateOf(r.data);
    },

    /**
     * States for many issues in ONE call.
     *
     * The reason the batch is in the contract at all: per-issue here would be a
     * process spawn plus a network round trip each, turning a 40-issue sync
     * from seconds into half a minute.
     */
    async getStates(ids) {
      const out = new Map();
      if (!ids?.length) return out;

      const r = await listByNumber(ids);
      if (!r.ok) {
        onWarn?.(`could not read issue states in bulk: ${r.error}`);
        for (const id of ids) out.set(id, UNKNOWN);
        return out;
      }

      for (const id of ids) {
        const n = numberOf(id);
        // Not in the answer means we could not read it, not that it is in some
        // default state. UNKNOWN keeps the reconciler's hands off it.
        out.set(id, n && r.byNumber.has(n) ? stateOf(r.byNumber.get(n)) : UNKNOWN);
      }
      return out;
    },

    /**
     * Which of `ids` are in the right state but say otherwise, and how.
     *
     * The read half of the representation pair (see lib/provider.mjs). Batched
     * for the same reason `getStates` is.
     *
     * A read that fails answers null — "nothing to repair" — rather than
     * guessing. The same failed read has already made `getStates` report
     * UNKNOWN, so the reconciler skips the issue with a reason on stderr; a
     * `checkRepresentation` that guessed here would turn an unreadable issue
     * into a write.
     *
     * @returns {Promise<Map<string, ?string>>}
     */
    async checkRepresentation(ids) {
      const out = new Map();
      if (!ids?.length) return out;

      const r = await listByNumber(ids);
      if (!r.ok) {
        onWarn?.(`could not check issue labels in bulk: ${r.error}`);
        for (const id of ids) out.set(id, null);
        return out;
      }

      for (const id of ids) {
        const n = numberOf(id);
        out.set(id, n && r.byNumber.has(n) ? driftOf(r.byNumber.get(n)) : null);
      }
      return out;
    },

    /**
     * Bring one issue's labels in line with the state it is already in.
     *
     * The write half of the pair, and deliberately NOT a transition: it never
     * opens or closes an issue, so a repair cannot move a ticket by accident,
     * and nothing downstream records a second close for work closed once.
     *
     * Rule 3 all the same — it reads back, and reports drift that survived the
     * write as a failure rather than as a success nobody checked.
     */
    async repairRepresentation(id) {
      const n = numberOf(id);
      if (!n) return { ok: false, error: `"${id}" is not a GitHub issue reference` };

      const gate = await ensureGh();
      if (!gate.ok) return gate;

      const view = () => json(['issue', 'view', n, '-R', repo, '--json', 'state,stateReason,labels']);

      const before = await view();
      if (!before.ok) return { ok: false, error: `could not read ${id}: ${before.error}` };

      const why = driftOf(before.data);
      if (!why) {
        return { ok: true, repaired: false, state: stateOf(before.data), why: 'labels already agree' };
      }

      const state = stateOf(before.data);
      const wanted = labelFor(state);
      const label = await ensureLabel(wanted);
      if (!label.ok) return label;

      const present = ladderLabelsOn(before.data);
      const args = labelEditArgs(n, {
        add: wanted && !present.includes(wanted) ? [wanted] : [],
        remove: present.filter((l) => l !== wanted),
      });
      if (args) {
        const edit = await call(args);
        if (!edit.ok) return { ok: false, error: `could not relabel ${id}: ${edit.stderr}` };
      }

      const after = await view();
      if (!after.ok) {
        return { ok: false, error: `relabelled ${id} but could not read it back: ${after.error}` };
      }
      const left = driftOf(after.data);
      if (left) return { ok: false, error: `${id} is still ${left}` };

      return { ok: true, repaired: true, state: stateOf(after.data), why };
    },

    /**
     * Every open issue in the repository, whatever it is labelled.
     *
     * Not `search` with an empty query: search exists for dup-checking and a
     * fuzzy answer serves that fine, while this one has to be complete enough
     * for a caller to count. `--search` is also the fuzzy, eventually-consistent
     * index; a plain `issue list` is the repository's own answer.
     *
     * `state` comes back through the same `stateOf` every other read uses, so
     * an issue with no ladder label reads as the first rung rather than being
     * dropped — those are precisely the issues nothing else in this tool can
     * see, since they have no branch and no PR to be discovered from.
     *
     * One extra row is fetched so `truncated` is a fact rather than the
     * ambiguity of a full page: `gh` fills `--limit` newest-first, so a caller
     * that hit the cap knows it saw the newest N and not the whole board.
     */
    async listOpen({ limit = 100 } = {}) {
      const r = await json([
        'issue', 'list',
        '-R', repo,
        '--state', 'open',
        '--limit', String(limit + 1),
        '--json', 'number,title,url,labels,state',
      ]);
      if (!r.ok) return r;

      const all = r.data ?? [];
      const truncated = all.length > limit;
      const rows = all
        .slice(0, limit)
        .map((i) => ({
          id: `#${i.number}`,
          title: i.title ?? '',
          state: stateOf(i),
          url: i.url ?? '',
        }))
        .sort((a, b) => Number(numberOf(a.id)) - Number(numberOf(b.id)));
      return { ok: true, data: rows, truncated };
    },

    async search(keywords, { limit = 15 } = {}) {
      const r = await json([
        'issue', 'list',
        '-R', repo,
        '--state', 'open',
        '--search', keywords,
        '--limit', String(limit),
        '--json', 'number,title,url',
      ]);
      if (!r.ok) return r;
      const rows = (r.data ?? [])
        .map((i) => ({ id: `#${i.number}`, title: i.title ?? '', url: i.url }))
        .sort((a, b) => Number(numberOf(a.id)) - Number(numberOf(b.id)));
      return { ok: true, data: rows };
    },

    /**
     * Move an issue to a rung: add its label, drop the sibling rungs', and
     * open or close as the rung requires. Then read back (rule 3) — a label
     * edit can no-op, and GitHub may have closed the issue from a PR while we
     * were deciding.
     */
    async setState(id, rung, comment) {
      const resolved = resolveRung(config, rung);
      if (!resolved.ok) return resolved;
      const target = resolved.state;

      const n = numberOf(id);
      if (!n) return { ok: false, error: `"${id}" is not a GitHub issue reference` };

      const gate = await ensureGh();
      if (!gate.ok) return gate;

      const wanted = labelFor(target);
      const label = await ensureLabel(wanted);
      if (!label.ok) return label;

      const args = labelEditArgs(n, {
        add: wanted ? [wanted] : [],
        remove: mappable.map(labelFor).filter((l) => l && l !== wanted),
      });
      if (args) {
        const edit = await call(args);
        if (!edit.ok) return { ok: false, error: `could not label ${id}: ${edit.stderr}` };
      }

      const shouldClose = target === config.states.done;
      const close = shouldClose
        ? await call(['issue', 'close', n, '-R', repo, '--reason', 'completed'])
        : await call(['issue', 'reopen', n, '-R', repo]);
      // Reopening an already-open issue is an error on gh, and a harmless one.
      if (!close.ok && shouldClose) {
        return { ok: false, error: `could not close ${id}: ${close.stderr}` };
      }

      if (comment) {
        const c = await provider.comment(id, comment);
        if (!c.ok) return c;
      }

      return { ok: true, state: await provider.getState(id) };
    },

    async comment(id, text) {
      const n = numberOf(id);
      if (!n) return { ok: false, error: `"${id}" is not a GitHub issue reference` };
      const gate = await ensureGh();
      if (!gate.ok) return gate;

      // Via stdin, not argv: a summary can be long enough to matter.
      const r = await call(['issue', 'comment', n, '-R', repo, '--body-file', '-'], { input: text });
      if (!r.ok) return { ok: false, error: `comment on ${id}: ${r.stderr}` };
      return { ok: true };
    },

    async create({ summary, description, type }) {
      const gate = await ensureGh();
      if (!gate.ok) return gate;

      const warnings = [];
      const args = ['issue', 'create', '-R', repo, '--title', summary, '--body-file', '-'];
      if (type && gh.labels?.type?.[type]) args.push('--label', gh.labels.type[type]);
      else if (type) warnings.push(`no GitHub label mapped for type "${type}" — created without it`);

      const r = await call(args, { input: description ?? '' });
      if (!r.ok) return { ok: false, error: `could not create the issue: ${r.stderr}` };

      // `gh issue create` prints no JSON — only the new issue's URL. This is
      // the most brittle line in the adapter, so a parse failure falls back to
      // finding the issue by title: the issue exists either way, and losing its
      // number would be the worse outcome.
      const m = /\/issues\/(\d+)\s*$/.exec(r.stdout.trim().split('\n').pop() ?? '');
      if (m) return { ok: true, id: `#${m[1]}`, url: `https://github.com/${repo}/issues/${m[1]}`, warnings };

      const found = await json(['issue', 'list', '-R', repo, '--limit', '5', '--json', 'number,title,url']);
      const hit = found.ok ? (found.data ?? []).find((i) => i.title === summary) : null;
      if (hit) {
        warnings.push('could not parse the URL gh printed; matched the new issue by title instead');
        return { ok: true, id: `#${hit.number}`, url: hit.url, warnings };
      }

      return {
        ok: false,
        error: `the issue may have been created, but gh printed no usable URL: ${r.stdout.slice(0, 200)}`,
      };
    },
  };

  return { ok: true, provider };
}

/** A `gh` issue object as a NormalizedIssue (see lib/provider.mjs). */
export function normalizeIssue(raw, { repo, stateOf }) {
  if (!raw) return null;

  const labels = (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  const assignees = (raw.assignees ?? []).map((a) => a?.login).filter(Boolean);

  // Sorted, so the same issue renders the same bytes on every run.
  const fields = [
    { name: 'Assignees', value: assignees.join(', ') },
    { name: 'Author', value: raw.author?.login ?? '' },
    { name: 'Labels', value: [...labels].sort().join(', ') },
  ]
    .filter((f) => f.value !== '')
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: `#${raw.number}`,
    title: raw.title ?? '',
    url: raw.url ?? (repo ? `https://github.com/${repo}/issues/${raw.number}` : ''),
    body: raw.body ?? '',
    state: stateOf ? stateOf(raw) : UNKNOWN,
    assignee: assignees[0] ?? null,
    fields,
    comments: (raw.comments ?? []).map((c) => ({
      author: c.author?.login ?? 'unknown',
      at: c.createdAt ?? null,
      body: c.body ?? '',
    })),
    meta: {
      closed: raw.state === 'CLOSED',
      closeReason: raw.stateReason ?? null,
      labels: [...labels].sort(),
    },
  };
}
