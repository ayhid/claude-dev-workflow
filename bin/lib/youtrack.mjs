/**
 * Thin YouTrack REST client for the installer.
 *
 * Every call returns { ok, data, error } rather than throwing, so the installer
 * can degrade to manual entry when the instance is unreachable instead of
 * dying halfway through a wizard.
 */

const TIMEOUT_MS = 15_000;

async function request(baseUrl, token, path, params = {}) {
  const url = new URL(path, baseUrl.replace(/\/+$/, '') + '/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
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
      const detail = data?.error_description || data?.error || String(data).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}: ${detail}` };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? `no response within ${TIMEOUT_MS / 1000}s` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Confirm the token works and return who it belongs to. */
export async function whoami(baseUrl, token) {
  const r = await request(baseUrl, token, 'api/users/me', { fields: 'login,fullName' });
  if (!r.ok) return r;
  return { ok: true, data: r.data?.login || r.data?.fullName || 'unknown' };
}

/** Every project the token can see: [{ id, shortName, name }]. */
export async function listProjects(baseUrl, token) {
  return request(baseUrl, token, 'api/admin/projects', {
    fields: 'id,shortName,name',
    $top: '500',
  });
}

/**
 * The real values of a project's State / Type / Priority fields.
 *
 * This is the whole reason the installer talks to the API at all: state names
 * differ per project, and a `State X` command YouTrack does not recognise fails
 * — sometimes with a 200 that applies nothing. Picking from the live list means
 * the config can never name a state that does not exist.
 */
export async function projectFieldValues(baseUrl, token, projectId) {
  const r = await request(baseUrl, token, `api/admin/projects/${projectId}/customFields`, {
    fields: 'field(name),bundle(values(name,isResolved,ordinal))',
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
