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
 * 3. **Plan.** It carries a `## Plan` comment. The fleet consumes plans and
 *    never writes one: a ticket nobody has planned is not a candidate, it is a
 *    ticket for `/dev-plan`.
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
 */
import { classifyUnits } from './units.mjs';

/** The literal heading `/dev-plan` §5 writes its comment with. */
const PLAN_HEADING = /^##[ \t]+Plan[ \t]*$/im;

/** The section of a plan that holds the agreed criteria, when it says so. */
const CRITERIA_HEADING = /^(#{2,4})[ \t]+(?:Acceptance\s+criteria|Criteria)[ \t]*$/im;

/** One agreed criterion: a task-list item, checked or not. */
const CRITERION = /^[ \t]*[-*][ \t]+\[[ xX]\]/gm;

/**
 * The body of the ticket's `## Plan` comment, or null.
 *
 * The newest one wins: a plan revised after review is posted as a second
 * comment, and the ticket then carries both.
 *
 * @param {Array<{author?: string, at?: ?string, body?: string}>} comments
 * @returns {?string}
 */
export function planOf(comments = []) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = String(comments[i]?.body ?? '');
    if (PLAN_HEADING.test(body)) return body;
  }
  return null;
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
 * @param {Array<{id: string, type?: ?string, dependsOn?: string[], comments?: Array<{body?: string}>}>} tickets
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

    const plan = planOf(t.comments);
    if (!plan) {
      out.set(t.id, {
        bucket: 'unplanned',
        term: 'plan',
        why: 'no "## Plan" comment — the fleet consumes plans, it does not write them',
      });
      continue;
    }

    out.set(t.id, { bucket: 'ready', criteria: countCriteria(plan) });
  }

  return out;
}
