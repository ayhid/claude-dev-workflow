/**
 * Work units: a parent issue split into children that can be built apart.
 *
 * Pure — no I/O, no git, no tracker. `scripts/cmd/split.mjs` writes what this
 * renders and `scripts/cmd/build.mjs` reads what this parses, so the whole
 * relation between two units is testable as a round trip.
 *
 * ## Where a dependency lives
 *
 * In the child's body, as one line: `Depends on: #43, #44`. Neither tracker
 * has a portable "blocked by" the adapters could read back the same way, and a
 * line in the body is visible to a person reading the issue, survives every
 * session, and round-trips through the same `extractIssueIds` the reconciler
 * already trusts to read IDs out of PR titles. Nothing is inferred from
 * prose: only that one line is read.
 *
 * ## What "ready" means
 *
 * Tracker state first, dependencies second. A unit is ready when it sits on
 * the first ladder rung — untouched — and every unit it depends on is at
 * `states.done`. UNKNOWN and off-ladder states are never ready, in either
 * position: the reconciler leaves those alone (`lib/sync.mjs`), and a build
 * that started work on an unreadable ticket would be guessing with a worktree.
 */
import { rankOf } from './config.mjs';
import { extractIssueIds } from './sync.mjs';
import { UNKNOWN } from './sync.mjs';

const DEPENDS_ON = /^depends on:(.*)$/im;
const REPO = /^repo:[ \t]*(\S+)[ \t]*$/im;

/**
 * The body a child issue is filed with: the unit's own text, then a `Repo:`
 * line when the project has several repos, then the dependency line when there
 * is anything to depend on.
 *
 * @param {{description: string, dependsOn?: string[], repo?: string}} unit
 */
export function renderUnitBody({ description, dependsOn = [], repo = null }) {
  const text = String(description ?? '').replace(/\s+$/, '');
  const trailer = [];
  if (repo) trailer.push(`Repo: ${repo}`);
  if (dependsOn.length) trailer.push(`Depends on: ${dependsOn.join(', ')}`);
  return trailer.length ? `${text}\n\n${trailer.join('\n')}\n` : `${text}\n`;
}

/** The configured repo path on a body's `Repo:` line, or null. */
export function parseUnitRepo(body) {
  const m = REPO.exec(String(body ?? ''));
  return m ? m[1] : null;
}

/**
 * The IDs on a body's `Depends on:` line, canonical and deduplicated.
 *
 * Only that line. An ID mentioned in the prose above it is a reference, not a
 * dependency, and reading it as one would block a unit on a ticket it merely
 * cites.
 *
 * @param {string} body
 * @param {import('./issueid.mjs').IdSyntax} syntax
 * @returns {string[]}
 */
export function parseDependsOn(body, syntax) {
  const m = DEPENDS_ON.exec(String(body ?? ''));
  if (!m) return [];
  const ids = extractIssueIds(m[1], syntax).map((id) => syntax.canonical(id));
  return [...new Set(ids)];
}

/**
 * Units in the order they can be built: each wave depends only on earlier ones.
 *
 * Kahn's algorithm, with the input order kept inside a wave so the same file
 * prints the same plan (rule 4 of the provider contract, applied here). A
 * dependency on something outside the set — a ticket that is not one of these
 * units — cannot be ordered and is reported as `external` rather than treated
 * as satisfied or as a cycle.
 *
 * @param {Array<{id: string, dependsOn?: string[]}>} units
 * @returns {{ok: true, waves: string[][], waveOf: Map<string, number>, external: Array<{id: string, dependsOn: string[]}>} | {ok: false, error: string}}
 */
export function computeWaves(units) {
  const ids = new Set(units.map((u) => u.id));
  const external = [];
  const internalDeps = new Map();

  for (const u of units) {
    const deps = u.dependsOn ?? [];
    const outside = deps.filter((d) => !ids.has(d));
    if (outside.length) external.push({ id: u.id, dependsOn: outside });
    internalDeps.set(u.id, deps.filter((d) => ids.has(d)));
  }

  const waveOf = new Map();
  const waves = [];
  let remaining = units.map((u) => u.id);

  while (remaining.length) {
    const wave = remaining.filter((id) => internalDeps.get(id).every((d) => waveOf.has(d)));
    if (!wave.length) {
      return { ok: false, error: `dependency cycle between ${remaining.join(', ')} — no order builds them` };
    }
    for (const id of wave) waveOf.set(id, waves.length + 1);
    waves.push(wave);
    remaining = remaining.filter((id) => !waveOf.has(id));
  }

  return { ok: true, waves, waveOf, external };
}

/**
 * Each unit's bucket on the board.
 *
 *   done          at states.done
 *   review        at states.review
 *   in progress   at states.start, or anywhere past the first rung
 *   ready         untouched, and every dependency done
 *   blocked       untouched, waiting on the units listed in `waitsOn`
 *   unknown       UNKNOWN or off the ladder — never started automatically
 *
 * @param {Array<{id: string, dependsOn?: string[]}>} units
 * @param {Map<string, string>} states     every unit and dependency, from getStates
 * @param {object} config
 * @returns {Map<string, {bucket: string, waitsOn?: string[], why?: string}>}
 */
export function classifyUnits(units, states, config) {
  const done = config.states?.done;
  const review = config.states?.review;
  const startRank = rankOf(config, config.states?.start);

  const out = new Map();
  for (const u of units) {
    const state = states.get(u.id) ?? UNKNOWN;
    const rank = rankOf(config, state);

    if (state === UNKNOWN) {
      out.set(u.id, { bucket: 'unknown', why: 'state could not be read' });
      continue;
    }
    if (rank < 0) {
      out.set(u.id, {
        bucket: 'unknown',
        why: `"${state}" is off the ladder — add it to states.ladder for build to start it`,
      });
      continue;
    }
    if (state === done) {
      out.set(u.id, { bucket: 'done' });
      continue;
    }
    if (state === review) {
      out.set(u.id, { bucket: 'review' });
      continue;
    }
    if (rank >= startRank || rank > 0) {
      out.set(u.id, { bucket: 'in progress' });
      continue;
    }

    const waitsOn = (u.dependsOn ?? []).filter((d) => (states.get(d) ?? UNKNOWN) !== done);
    out.set(u.id, waitsOn.length ? { bucket: 'blocked', waitsOn } : { bucket: 'ready' });
  }

  return out;
}

/**
 * The IDs `build --start` may mount now, in input order.
 *
 * @param {Array<{id: string, dependsOn?: string[]}>} units
 * @param {Map<string, string>} states
 * @param {object} config
 * @returns {string[]}
 */
export function readyUnits(units, states, config) {
  const by = classifyUnits(units, states, config);
  return units.filter((u) => by.get(u.id)?.bucket === 'ready').map((u) => u.id);
}

/**
 * Validate `@units.json` — what `/dev-split` writes for `dev.mjs split`.
 *
 * Every refusal names the unit (1-based, as a person counts) and the field, so
 * the file can be fixed without reading this function. A dependency is an
 * index into the same file: the IDs do not exist yet when the file is written.
 *
 * @param {string} text
 * @param {object} config
 * @returns {{ok: true, units: Array<{summary: string, description: string, type: string, priority?: string, dependsOn: number[], repo?: string}>} | {ok: false, error: string}}
 */
export function parseUnitsFile(text, config) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `the units file is not valid JSON: ${err.message}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: 'the units file must be a non-empty JSON array of units' };
  }

  const types = config.issueTypes ?? [];
  const repoPaths = (config.repos ?? []).map((r) => r.path).filter(Boolean);
  const multiRepo = repoPaths.length > 1;

  const units = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const u = parsed[i];
    const at = `unit ${i + 1}`;
    const refuse = (what) => ({ ok: false, error: `${at}: ${what}` });

    if (!u || typeof u !== 'object' || Array.isArray(u)) return refuse('must be an object');
    if (typeof u.summary !== 'string' || !u.summary.trim()) return refuse('summary must be a non-empty string');
    if (typeof u.description !== 'string' || !/^##\s+Acceptance criteria\s*$/im.test(u.description)) {
      return refuse('description must carry a "## Acceptance criteria" section — a unit with no criteria cannot be verified');
    }
    if (typeof u.type !== 'string' || !types.includes(u.type)) {
      return refuse(`type "${u.type ?? ''}" is not one of the configured issueTypes (${types.join(', ')})`);
    }
    if (u.priority !== undefined && typeof u.priority !== 'string') return refuse('priority must be a string');

    const deps = u.dependsOn ?? [];
    if (!Array.isArray(deps)) return refuse('dependsOn must be an array of unit indexes');
    for (const d of deps) {
      if (!Number.isInteger(d)) return refuse(`dependsOn entry ${JSON.stringify(d)} is not a unit index (0-based)`);
      if (d === i) return refuse('dependsOn names the unit itself');
      if (d < 0 || d >= parsed.length) return refuse(`dependsOn index ${d} is outside the file (${parsed.length} units)`);
    }

    if (multiRepo) {
      if (typeof u.repo !== 'string' || !u.repo) {
        return refuse(`repo is required — this project configures ${repoPaths.length} repos (${repoPaths.join(', ')})`);
      }
      if (!repoPaths.includes(u.repo)) {
        return refuse(`repo "${u.repo}" is not configured (have: ${repoPaths.join(', ')})`);
      }
    } else if (u.repo !== undefined && typeof u.repo !== 'string') {
      return refuse('repo must be a string');
    }

    units.push({
      summary: u.summary.trim(),
      description: u.description,
      type: u.type,
      ...(u.priority !== undefined ? { priority: u.priority } : {}),
      dependsOn: [...deps],
      ...(u.repo !== undefined ? { repo: u.repo } : {}),
    });
  }

  return { ok: true, units };
}
