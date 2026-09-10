/**
 * The board selector: which tickets anywhere are ready to build, and in what
 * order.
 *
 * Pure — no I/O, no git, no tracker — like `lib/units.mjs`, whose subject is
 * the narrower one: children of a parent that has already been split. Board
 * level is a different question, so it gets its own file rather than a second
 * meaning for `classifyUnits`.
 *
 * ## What "fleet-ready" means — three terms, and nothing else
 *
 * 1. **Rung.** The ticket sits on the first ladder rung, untouched.
 * 2. **Dependencies.** Every unit on its `Depends on:` line is at `states.done`.
 * 3. **Plan.** It carries a `## Plan` comment, or an `## Acceptance criteria`
 *    section in its body — the shape `dev.mjs split` files a sub-issue with, and
 *    no comment beside it (#153). What a builder needs is a list of criteria,
 *    and both shapes carry one. The fleet consumes plans and never writes one:
 *    a ticket with neither is not a candidate, it is a ticket for `/dev-plan`.
 *
 * The first two are `classifyUnits`, called rather than restated — a board-wide
 * copy of the ladder rules would drift from the one `build` already trusts. The
 * third is this file's own.
 *
 * A ticket failing a term is reported in a named bucket carrying the **term it
 * failed**, and the terms are tried in the order above, so one ticket names one
 * term. Trying them in a different order would rename the failure of a ticket
 * that misses two, which is exactly the instability rule 4 of the provider
 * contract refuses.
 *
 * ## Ordering is a proposal, never a silent decision
 *
 * No priority field is configured on this project, and inferring one is
 * forbidden (`lib/provider.mjs` rule 2). So the order is computed from what is
 * already on the ticket — how many criteria its plan agreed, then what kind of
 * change it is — and printed for the user, who overrides it with an explicit
 * list that is taken verbatim.
 */
import { resolveBranchType } from './config.mjs';
import { classifyUnits } from './units.mjs';

/** The literal heading `/dev-plan` §5 writes its comment with. */
const PLAN_HEADING = /^##[ \t]+Plan[ \t]*$/im;

/** The literal heading a ticket body carries its criteria under — what `split` requires of a unit. */
const BODY_CRITERIA_HEADING = /^##[ \t]+Acceptance[ \t]+criteria[ \t]*$/im;

/** The section of a plan that holds the agreed criteria, when it says so. */
const CRITERIA_HEADING = /^(#{2,4})[ \t]+(?:Acceptance\s+criteria|Criteria)[ \t]*$/im;

/** One agreed criterion: a task-list item, checked or not. */
const CRITERION = /^[ \t]*[-*][ \t]+\[[ xX]\]/gm;

/**
 * Quick wins first: which kind of change goes before which.
 *
 * Only `fix` before `feat` is decided — a fix is the small, well-understood end
 * of a board and a feature the open-ended one. Everything else sits between
 * them at one rank and therefore keeps its input order, because ranking `docs`
 * against `chore` would be inventing the priority nobody configured.
 */
const TYPE_RANK = { fix: 0, feat: 2 };
const TYPE_RANK_DEFAULT = 1;

/**
 * Where an issue type sits in that order.
 *
 * A type the project maps to nothing ranks with the middle rather than being
 * refused: this is a printed proposal, and a selector that threw would hide the
 * whole board over one unmapped ticket. `renderBranch` still refuses it when
 * the ticket is actually started.
 */
function typeRank(config, issueType) {
  const branchType = resolveBranchType(config, issueType);
  if (!branchType.ok) return TYPE_RANK_DEFAULT;
  return TYPE_RANK[branchType.type] ?? TYPE_RANK_DEFAULT;
}

/**
 * The body of the ticket's `## Plan` comment, or null.
 *
 * The newest one wins: a plan revised after review is posted as a second
 * comment, and the ticket then carries both. Newest by `at`, never by position:
 * the provider contract promises each comment an ISO-8601 timestamp and the
 * list no order. A plan with no readable `at` ranks below every dated one, and
 * of two plans dated alike — or both undated — the later in the list wins.
 *
 * @param {Array<{author?: string, at?: ?string, body?: string}>} comments
 * @returns {?string}
 */
export function planOf(comments = []) {
  let newest = null;
  let newestAt = -Infinity;
  for (const c of comments) {
    const body = String(c?.body ?? '');
    if (!PLAN_HEADING.test(body)) continue;
    const parsed = Date.parse(c?.at ?? '');
    const at = Number.isNaN(parsed) ? -Infinity : parsed;
    if (at >= newestAt) {
      newest = body;
      newestAt = at;
    }
  }
  return newest;
}

/**
 * The ticket body's `## Acceptance criteria` section onwards, or null.
 *
 * A sub-issue filed by `dev.mjs split` carries its criteria here and has no
 * comment at all (#153). The text starts at the heading, so `countCriteria`
 * counts that section rather than any earlier one.
 *
 * @param {?string} body
 * @returns {?string}
 */
export function criteriaSectionOf(body) {
  const text = String(body ?? '');
  const m = BODY_CRITERIA_HEADING.exec(text);
  return m ? text.slice(m.index) : null;
}

/**
 * How many acceptance criteria a plan agreed.
 *
 * The `### Criteria` section when the plan has one, so the task list under
 * `### Verification` is not counted as criteria; the whole text otherwise, for
 * a plan written before the template had sections.
 *
 * @param {string} text
 * @returns {number}
 */
export function countCriteria(text) {
  const whole = String(text ?? '');
  const m = CRITERIA_HEADING.exec(whole);
  let section = whole;
  if (m) {
    const rest = whole.slice(m.index + m[0].length);
    const next = new RegExp(`^#{1,${m[1].length}}[ \\t]+\\S`, 'm').exec(rest);
    section = next ? rest.slice(0, next.index) : rest;
  }
  return (section.match(CRITERION) ?? []).length;
}

/**
 * Every ticket's bucket on the board, and the term it failed.
 *
 *   ready         all three terms hold; carries the plan's criteria count
 *   unplanned     term "plan"          — on the first rung, but nobody planned it
 *   blocked       term "dependencies"  — waiting on the units in `waitsOn`
 *   in progress   term "rung"          — already started
 *   review, done  term "rung"          — past building
 *   unknown       term "state"         — UNKNOWN, or off the ladder
 *
 * @param {Array<{id: string, type?: ?string, dependsOn?: string[], body?: string, comments?: Array<{body?: string}>}>} tickets
 * @param {Map<string, string>} states   every ticket and dependency, from getStates
 * @param {object} config
 * @returns {Map<string, {bucket: string, term?: string, why?: string, waitsOn?: string[], criteria?: number}>}
 */
export function classifyFleet(tickets, states, config) {
  const byUnit = classifyUnits(tickets, states, config);
  const out = new Map();

  for (const t of tickets) {
    const verdict = byUnit.get(t.id);

    if (verdict.bucket === 'unknown') {
      out.set(t.id, { ...verdict, term: 'state' });
      continue;
    }
    if (verdict.bucket === 'blocked') {
      out.set(t.id, { ...verdict, term: 'dependencies', why: `waiting on ${verdict.waitsOn.join(', ')}` });
      continue;
    }
    if (verdict.bucket !== 'ready') {
      out.set(t.id, { ...verdict, term: 'rung', why: `at "${states.get(t.id)}" — not on the first rung` });
      continue;
    }

    const plan = planOf(t.comments) ?? criteriaSectionOf(t.body);
    if (!plan) {
      out.set(t.id, {
        bucket: 'unplanned',
        term: 'plan',
        why: 'no "## Plan" comment and no "## Acceptance criteria" section — the fleet consumes plans, it does not write them',
      });
      continue;
    }

    out.set(t.id, { bucket: 'ready', criteria: countCriteria(plan) });
  }

  return out;
}

/**
 * The candidates in the order they are proposed to be built.
 *
 * Fewest agreed criteria first — the nearest thing to "quick win" that is
 * actually written on a ticket — then by what kind of change it is. Ties keep
 * their input order, so the same board prints the same order (rule 4).
 *
 * `explicit` is the user's own list and is returned **verbatim**: not
 * reordered, and not filtered against the candidates either. Dropping an ID
 * from it would be a silent decision, which is the one thing this ordering is
 * not allowed to make; the caller reports what it could not start. An empty
 * list is a list too, and comes back empty: only an omitted `explicit` gets the
 * proposed order.
 *
 * @param {Array<{id: string, type?: ?string, criteria?: number}>} candidates
 * @param {object} config
 * @param {{explicit?: ?string[]}} [opts]
 * @returns {string[]}
 */
export function orderCandidates(candidates, config, { explicit } = {}) {
  if (explicit != null) return [...explicit];

  return [...candidates]
    .map((c, at) => ({ c, at }))
    .sort((a, b) =>
      (a.c.criteria ?? 0) - (b.c.criteria ?? 0)
      || typeRank(config, a.c.type) - typeRank(config, b.c.type)
      || a.at - b.at)
    .map(({ c }) => c.id);
}

/**
 * The whole selection in one call: every ticket's bucket, and the order the
 * ready ones are proposed in.
 *
 * @param {Array<{id: string, type?: ?string, dependsOn?: string[], body?: string, comments?: Array<{body?: string}>}>} tickets
 * @param {Map<string, string>} states
 * @param {object} config
 * @param {{explicit?: ?string[]}} [opts]
 * @returns {{by: Map<string, object>, order: string[]}}
 */
export function selectFleet(tickets, states, config, { explicit } = {}) {
  const by = classifyFleet(tickets, states, config);
  const candidates = tickets
    .filter((t) => by.get(t.id).bucket === 'ready')
    .map((t) => ({ id: t.id, type: t.type, criteria: by.get(t.id).criteria }));

  return { by, order: orderCandidates(candidates, config, { explicit }) };
}
