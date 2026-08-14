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
export async function request(baseUrl, token, path, { params = {}, method = 'GET', body } = {}) {
  const url = new URL(path, `${String(baseUrl).replace(/\/+$/, '')}/`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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
