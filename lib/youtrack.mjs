/**
 * The YouTrack client, shared by the installer and the runtime scripts.
 *
 * Every call returns { ok, data, error } rather than throwing, so callers can
 * degrade — the installer falls back to manual entry when the instance is
 * unreachable instead of dying halfway through a wizard.
 *
 * Two API behaviours are encoded here rather than left to callers, because both
 * have shipped bugs before:
 *
 *   1. The commands API returns 200 for commands it did not apply. `applyCommand`
 *      therefore reads the state back and reports what it actually found; the
 *      HTTP status alone proves nothing.
 *   2. Only values *containing a space* may be braced. Braces mark where a
 *      multi-word value ends — they are not quoting. See `brace`.
 */

import { resolveRung } from './config.mjs';
import { UNKNOWN } from './sync.mjs';

const TIMEOUT_MS = 15_000;

/**
 * Brace a command value only when it contains a space.
 *
 * Both directions bite. `State {Staging}` is rejected outright with
 * "expected: {Staging}", and `Type {Bug} Priority {Critical}` is parsed as the
 * single value "{Bug} Priority" and 400s. This is the rule bb96c4e fixed; it
 * lives here once so it cannot drift between call sites again.
 *
 * @param {string} value
 */
export function brace(value) {
  const v = String(value);
  return v.includes(' ') ? `{${v}}` : v;
}

/** Build a `State X` / `Type Y Priority Z` style command string. */
export function commandFor(pairs) {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([field, value]) => `${field} ${brace(value)}`)
    .join(' ');
}

/**
 * One HTTP call. The token goes in a header and nowhere else.
 *
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: string, status?: number}>}
 */
export async function request(
  baseUrl,
  token,
  path,
  // `fetchImpl` is how the adapter injects its transport. It defaults to the
  // global at CALL time, not at module load, so a test that swaps
  // `globalThis.fetch` still works — that is what tests/youtrack.test.mjs does.
  { params = {}, method = 'GET', body, fetchImpl } = {},
) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const url = new URL(path, `${String(baseUrl).replace(/\/+$/, '')}/`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const detail = data?.error_description || data?.error || String(data).slice(0, 300);
      return { ok: false, status: res.status, error: describeStatus(res.status, detail, path) };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error:
        err.name === 'AbortError'
          ? `no response from ${baseUrl} within ${TIMEOUT_MS / 1000}s`
          : `network error contacting ${baseUrl}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeStatus(status, detail, what) {
  if (status === 400) return `YouTrack rejected ${what}: ${detail}`;
  if (status === 401 || status === 403) {
    return `authentication failed (HTTP ${status}) — check the token and its permissions`;
  }
  if (status === 404) return `not found (HTTP 404): ${what}`;
  return `YouTrack returned HTTP ${status} for ${what}: ${detail}`;
}

// --- installer-facing reads --------------------------------------------------

/** Confirm the token works and return who it belongs to. */
export async function whoami(baseUrl, token) {
  const r = await request(baseUrl, token, 'api/users/me', { params: { fields: 'login,fullName' } });
  if (!r.ok) return r;
  return { ok: true, data: r.data?.login || r.data?.fullName || 'unknown' };
}

/** Every project the token can see: [{ id, shortName, name }]. */
export async function listProjects(baseUrl, token) {
  return request(baseUrl, token, 'api/admin/projects', {
    params: { fields: 'id,shortName,name', $top: 500 },
  });
}

/**
 * The real values of a project's State / Type / Priority fields.
 *
 * This is why the installer talks to the API at all: state names differ per
 * project, and a `State X` command YouTrack does not recognise fails — sometimes
 * with a 200 that applies nothing. Picking from the live list means the config
 * can never name a state that does not exist.
 */
export async function projectFieldValues(baseUrl, token, projectId) {
  const r = await request(baseUrl, token, `api/admin/projects/${projectId}/customFields`, {
    params: { fields: 'field(name),bundle(values(name,isResolved,ordinal))' },
  });
  if (!r.ok) return r;

  const byName = {};
  for (const cf of Array.isArray(r.data) ? r.data : []) {
    const name = cf?.field?.name;
    const values = cf?.bundle?.values;
    if (!name || !Array.isArray(values)) continue;
    byName[name] = values
      .slice()
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
      .map((v) => ({ name: v.name, isResolved: Boolean(v.isResolved) }));
  }
  return { ok: true, data: byName };
}

/** Resolve the internal project id from its shortName. */
export async function resolveProjectId(baseUrl, token, shortName, cached) {
  if (cached) return { ok: true, data: cached };
  const r = await listProjects(baseUrl, token);
  if (!r.ok) return r;
  const hit = (r.data ?? []).find((p) => p.shortName === shortName);
  if (!hit) {
    const visible = (r.data ?? []).map((p) => p.shortName).join(', ');
    return { ok: false, error: `project '${shortName}' not found at ${baseUrl} (visible: ${visible})` };
  }
  return { ok: true, data: hit.id };
}

// --- issue reads -------------------------------------------------------------

const ISSUE_FIELDS =
  'idReadable,summary,description,' +
  'customFields(name,value(name,login,fullName,presentation,text,minutes)),' +
  'comments(text,created,author(login,fullName))';

export async function getIssue(baseUrl, token, issue) {
  return request(baseUrl, token, `api/issues/${issue}`, { params: { fields: ISSUE_FIELDS } });
}

/** Current State field value, or 'unknown' when it cannot be read. */
export async function getState(baseUrl, token, issue) {
  const r = await request(baseUrl, token, `api/issues/${issue}`, {
    params: { fields: 'customFields(name,value(name))' },
  });
  if (!r.ok) return 'unknown';
  const field = (r.data?.customFields ?? []).find((f) => f.name === 'State');
  return field?.value?.name ?? 'unknown';
}

/** Open issues in `project` matching free-text `keywords`. */
export async function searchIssues(baseUrl, token, project, keywords, top = 15) {
  return request(baseUrl, token, 'api/issues', {
    params: {
      query: `project: ${project} #Unresolved ${keywords}`,
      fields: 'idReadable,summary',
      $top: top,
    },
  });
}

// --- issue writes ------------------------------------------------------------

/**
 * Apply a command, then read the state back.
 *
 * The read-back is the actual check: a 200 here does not mean the command
 * applied. Callers should report `state`, not the absence of an error.
 */
export async function applyCommand(baseUrl, token, issue, query, comment) {
  const body = {
    query,
    issues: [{ idReadable: issue }],
    usesMarkdown: true,
    ...(comment ? { comment } : {}),
  };
  const r = await request(baseUrl, token, 'api/commands', { method: 'POST', body });
  if (!r.ok) return { ok: false, error: `command '${query}' on ${issue}: ${r.error}` };

  const state = await getState(baseUrl, token, issue);
  return { ok: true, state };
}

/**
 * Post a comment.
 *
 * `comment` is not a YouTrack command — the commands API 400s on it — so
 * comment-only updates go to the dedicated endpoint.
 */
export async function postComment(baseUrl, token, issue, text) {
  const r = await request(baseUrl, token, `api/issues/${issue}/comments`, {
    method: 'POST',
    params: { fields: 'id' },
    body: { text, usesMarkdown: true },
  });
  if (!r.ok) return { ok: false, error: `comment on ${issue}: ${r.error}` };
  return { ok: true, data: r.data };
}

/** Create an issue. Resolves to its readable ID. */
export async function createIssue(baseUrl, token, projectId, summary, description) {
  const r = await request(baseUrl, token, 'api/issues', {
    method: 'POST',
    params: { fields: 'idReadable' },
    body: { project: { id: projectId }, summary, description, usesMarkdown: true },
  });
  if (!r.ok) return r;
  const id = r.data?.idReadable;
  if (!id) {
    return {
      ok: false,
      error: `issue may have been created, but the response carried no idReadable: ${JSON.stringify(r.data).slice(0, 300)}`,
    };
  }
  return { ok: true, data: id };
}

/** Read back the Type and Priority actually set on an issue. */
export async function typeAndPriority(baseUrl, token, issue) {
  const r = await request(baseUrl, token, `api/issues/${issue}`, {
    params: { fields: 'customFields(name,value(name))' },
  });
  if (!r.ok) return '';
  return (r.data?.customFields ?? [])
    .filter((f) => f.name === 'Type' || f.name === 'Priority')
    .map((f) => `${f.name}=${f.value?.name ?? 'unset'}`)
    .join(' ');
}

// --- normalisation -----------------------------------------------------------

/**
 * Render a custom-field value, whatever shape it arrives in.
 *
 * YouTrack returns a different shape per field type — a bundle element has
 * `name`, a user has `login`/`fullName`, a period has `minutes`. Rendering here
 * rather than in the command is what lets `scripts/cmd/fetch.mjs` print an
 * issue without knowing which backend it came from.
 */
export function renderValue(v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(renderValue).join(', ');
  if (typeof v === 'object') {
    if (typeof v.minutes === 'number') return `${v.minutes}m`;
    return v.name ?? v.fullName ?? v.login ?? v.presentation ?? v.text ?? '—';
  }
  return String(v);
}

const fieldValue = (issue, name) =>
  renderValue((issue?.customFields ?? []).find((f) => f.name === name)?.value);

/**
 * A raw YouTrack issue as a `NormalizedIssue` (see lib/provider.mjs).
 *
 * Timestamps become ISO-8601 here: YouTrack sends epoch milliseconds, GitHub
 * sends ISO strings, and a renderer that had to know which is which would not
 * be provider-blind. Fields arrive sorted so the same issue prints the same
 * bytes on every run.
 */
export function normalizeIssue(raw, { baseUrl } = {}) {
  const id = raw?.idReadable ?? '';
  const state = fieldValue(raw, 'State');

  // The login, deliberately, not the display name: it is stable, unique, and
  // what `@mention` needs. `renderValue` prefers fullName for display, which is
  // right for a field list and wrong for an identity.
  const assigneeRaw = (raw?.customFields ?? []).find((f) => f.name === 'Assignee')?.value;
  const assignee = assigneeRaw?.login ?? (assigneeRaw ? renderValue(assigneeRaw) : null);

  const fields = (raw?.customFields ?? [])
    .filter((f) => f.name !== 'State' && f.name !== 'Assignee')
    .map((f) => ({ name: f.name, value: renderValue(f.value) }))
    .filter((f) => f.value !== '—')
    .sort((a, b) => a.name.localeCompare(b.name));

  const comments = (raw?.comments ?? []).map((c) => ({
    author: c.author?.login ?? 'unknown',
    at: typeof c.created === 'number' ? new Date(c.created).toISOString() : null,
    body: c.text ?? '',
  }));

  return {
    id,
    title: raw?.summary ?? '',
    url: baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/issue/${id}` : '',
    body: raw?.description ?? '',
    state: state === '—' ? UNKNOWN : state,
    assignee: assignee === '—' ? null : assignee,
    fields,
    comments,
    meta: { closed: false, closeReason: null, labels: [] },
  };
}


// --- the adapter -------------------------------------------------------------

/**
 * The YouTrack implementation of the provider contract.
 *
 * Everything above this line stays exported: `bin/install.mjs` calls three of
 * those functions directly during the setup wizard, before any config exists to
 * build a provider from.
 *
 * The commands DSL (`brace`, `commandFor`) is now internal to this file. No
 * caller outside it spells a command again — which is what removes the
 * `POST api/commands` that `scripts/cmd/create.mjs` used to issue behind this
 * library's back, and with it the brace rule the skills had to document.
 */
export function createYouTrackProvider({ config, fetch: fetchImpl, onWarn }) {
  const { baseUrl } = config ?? {};
  if (!baseUrl) {
    return {
      ok: false,
      error: 'no YouTrack URL configured — set YOUTRACK_BASE_URL or add "baseUrl" (run /dev-init)',
    };
  }

  // Resolved lazily: the installer's own probes need a provider before a token
  // is necessarily available, and `config` alone cannot tell us.
  let tokenPromise = null;
  const withToken = async (fn) => {
    if (!tokenPromise) {
      tokenPromise = import('./token.mjs').then((m) => m.resolveToken(config));
    }
    const t = await tokenPromise;
    if (!t.ok) return { ok: false, error: t.error };
    return fn(t.token);
  };

  const call = (token, path, opts = {}) => request(baseUrl, token, path, { ...opts, fetchImpl });

  const provider = {
    name: 'youtrack',
    capabilities: {
      types: true,
      priorities: true,
      assignee: true,
      freeTextSearch: true,
      rawCommand: true,
    },

    async whoami() {
      return withToken(async (token) => {
        const r = await call(token, 'api/users/me', { params: { fields: 'login,fullName' } });
        if (!r.ok) return r;
        return { ok: true, data: r.data?.login ?? r.data?.fullName ?? 'unknown' };
      });
    },

    async resolveProject() {
      return withToken(async (token) => {
        const r = await call(token, 'api/admin/projects', {
          params: { fields: 'id,shortName,name', $top: 500 },
        });
        if (!r.ok) return r;
        const hit = (r.data ?? []).find((p) => p.shortName === config.project);
        if (!hit) {
          return { ok: false, error: `project "${config.project}" not found on ${baseUrl}` };
        }
        return {
          ok: true,
          data: { id: hit.id, key: hit.shortName, name: hit.name, url: `${baseUrl}/projects/${hit.id}` },
        };
      });
    },

    async getIssue(id) {
      return withToken(async (token) => {
        const r = await call(token, `api/issues/${id}`, { params: { fields: ISSUE_FIELDS } });
        if (!r.ok) return r;
        return { ok: true, data: normalizeIssue(r.data, { baseUrl }) };
      });
    },

    async getState(id) {
      const r = await withToken(async (token) => {
        const res = await call(token, `api/issues/${id}`, {
          params: { fields: 'customFields(name,value(name))' },
        });
        if (!res.ok) return res;
        const field = (res.data?.customFields ?? []).find((f) => f.name === 'State');
        return { ok: true, data: field?.value?.name ?? UNKNOWN };
      });
      if (!r.ok) {
        // Rule 3: never discard the reason. Without this a 500 shows up in the
        // sync table as `?` and the cause is gone.
        onWarn?.(`could not read the state of ${id}: ${r.error}`);
        return UNKNOWN;
      }
      return r.data;
    },

    /**
     * States for many issues.
     *
     * YouTrack can answer this in one query, so it does. The batch exists in
     * the contract because the GitHub adapter pays a process spawn per issue,
     * and the reconciler's loop should not have to know the difference.
     */
    async getStates(ids) {
      const out = new Map();
      if (!ids?.length) return out;

      const r = await withToken((token) =>
        call(token, 'api/issues', {
          params: {
            query: ids.map((i) => `issue id: ${i}`).join(' or '),
            fields: 'idReadable,customFields(name,value(name))',
            $top: ids.length,
          },
        }),
      );

      if (!r.ok) {
        onWarn?.(`could not read issue states in bulk: ${r.error}`);
        for (const id of ids) out.set(id, UNKNOWN);
        return out;
      }

      for (const issue of r.data ?? []) {
        const field = (issue.customFields ?? []).find((f) => f.name === 'State');
        out.set(issue.idReadable, field?.value?.name ?? UNKNOWN);
      }
      // Anything the query did not return is unreadable, not absent.
      for (const id of ids) if (!out.has(id)) out.set(id, UNKNOWN);
      return out;
    },

    async search(keywords, { limit = 15 } = {}) {
      return withToken(async (token) => {
        const r = await call(token, 'api/issues', {
          params: {
            query: `project: ${config.project} #Unresolved ${keywords}`,
            fields: 'idReadable,summary',
            $top: limit,
          },
        });
        if (!r.ok) return r;
        const rows = (r.data ?? [])
          .map((i) => ({ id: i.idReadable, title: i.summary ?? '', url: `${baseUrl}/issue/${i.idReadable}` }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { ok: true, data: rows };
      });
    },

    /**
     * Move an issue to a rung (`start`/`review`/`done`) or an explicit ladder
     * state, optionally with a comment.
     *
     * Resolution happens *here*, not in the caller. Rule 2 is only a guarantee
     * if the adapter enforces it: a command layer that resolved rungs itself
     * would leave every future caller free to pass an unvalidated string, and
     * on YouTrack an unrecognised state is accepted with a 200 that changes
     * nothing.
     *
     * Rule 3, and the reason it is a rule: because of that same 200, the state
     * returned is always the one read back afterwards, never the one requested.
     */
    async setState(id, rung, comment) {
      const resolved = resolveRung(config, rung);
      if (!resolved.ok) return resolved;

      return withToken(async (token) => {
        const query = commandFor({ State: resolved.state });
        const r = await call(token, 'api/commands', {
          method: 'POST',
          body: {
            query,
            issues: [{ idReadable: id }],
            usesMarkdown: true,
            ...(comment ? { comment } : {}),
          },
        });
        if (!r.ok) return { ok: false, error: `command '${query}' on ${id}: ${r.error}` };

        const res = await call(token, `api/issues/${id}`, {
          params: { fields: 'customFields(name,value(name))' },
        });
        if (!res.ok) return { ok: false, error: `applied '${query}' but could not read ${id} back: ${res.error}` };
        const field = (res.data?.customFields ?? []).find((f) => f.name === 'State');
        return { ok: true, state: field?.value?.name ?? UNKNOWN };
      });
    },

    async comment(id, text) {
      return withToken(async (token) => {
        // `comment` is not a YouTrack command — the commands API 400s on it.
        const r = await call(token, `api/issues/${id}/comments`, {
          method: 'POST',
          params: { fields: 'id' },
          body: { text, usesMarkdown: true },
        });
        if (!r.ok) return { ok: false, error: `comment on ${id}: ${r.error}` };
        return { ok: true };
      });
    },

    async create({ summary, description, type, priority }) {
      return withToken(async (token) => {
        const projectId = config.projectId
          ? config.projectId
          : await (async () => {
              const p = await provider.resolveProject();
              return p.ok ? p.data.id : null;
            })();
        if (!projectId) return { ok: false, error: `could not resolve project "${config.project}"` };

        const r = await call(token, 'api/issues', {
          method: 'POST',
          params: { fields: 'idReadable' },
          body: { project: { id: projectId }, summary, description, usesMarkdown: true },
        });
        if (!r.ok) return r;
        const id = r.data?.idReadable;
        if (!id) {
          return {
            ok: false,
            error: `issue may have been created, but the response carried no idReadable: ${JSON.stringify(r.data).slice(0, 300)}`,
          };
        }

        // Custom fields need per-project field ids on the issues endpoint, so
        // they go through the commands API as a second call. A failure here is
        // a warning, not an error: the issue exists and losing its ID would be
        // the worse outcome.
        const warnings = [];
        const query = commandFor({ Type: type, Priority: priority });
        if (query) {
          const c = await call(token, 'api/commands', {
            method: 'POST',
            body: { query, issues: [{ idReadable: id }] },
          });
          if (!c.ok) warnings.push(`created ${id}, but applying '${query}' failed: ${c.error}`);
        }

        return { ok: true, id, url: `${baseUrl}/issue/${id}`, warnings };
      });
    },

    /** YouTrack's native command DSL. Guarded by capabilities.rawCommand. */
    async raw(id, query, comment) {
      return withToken(async (token) => {
        const r = await call(token, 'api/commands', {
          method: 'POST',
          body: {
            query,
            issues: [{ idReadable: id }],
            usesMarkdown: true,
            ...(comment ? { comment } : {}),
          },
        });
        if (!r.ok) return { ok: false, error: `command '${query}' on ${id}: ${r.error}` };
        return { ok: true, state: await provider.getState(id) };
      });
    },
  };

  return { ok: true, provider };
}
