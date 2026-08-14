import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { applyCommand, brace, commandFor, getState, request } from '../lib/youtrack.mjs';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a handler receiving (url, init). */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body = {} } = (await handler(new URL(url), init)) ?? {};
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

// --- the brace rule ----------------------------------------------------------
// bb96c4e. Braces mark where a multi-word value ends; they are not quoting.

test('brace wraps only values containing a space', () => {
  assert.equal(brace('In Review'), '{In Review}');
  assert.equal(brace('Staging'), 'Staging', 'a single word braced is rejected outright');
  assert.equal(brace('Bug'), 'Bug');
  assert.equal(brace("Won't Fix"), "{Won't Fix}");
});

test('commandFor braces each value independently', () => {
  // `Type {Bug} Priority {Critical}` parses as the single value "{Bug} Priority"
  // and 400s, so neither single-word value may be braced.
  assert.equal(commandFor({ Type: 'Bug', Priority: 'Critical' }), 'Type Bug Priority Critical');
  assert.equal(commandFor({ State: 'In Review' }), 'State {In Review}');
  assert.equal(commandFor({ Type: 'Bug', Priority: 'Show stopper' }), 'Type Bug Priority {Show stopper}');
});

test('commandFor drops empty values', () => {
  assert.equal(commandFor({ Type: 'Bug', Priority: '' }), 'Type Bug');
  assert.equal(commandFor({ Type: 'Bug', Priority: null }), 'Type Bug');
});

// --- request -----------------------------------------------------------------

test('request sends the token as a bearer header and never in the url', async () => {
  const calls = stubFetch(() => ({ body: { ok: true } }));
  await request('https://a.cloud', 'secret-token', 'api/users/me', { params: { fields: 'login' } });

  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.ok(!calls[0].url.href.includes('secret-token'), 'the token must never reach the URL');
  assert.equal(calls[0].url.searchParams.get('fields'), 'login');
});

test('request joins paths against a base url with no trailing slash', async () => {
  const calls = stubFetch(() => ({ body: {} }));
  await request('https://a.cloud', 't', 'api/issues/ABC-1');
  assert.equal(calls[0].url.pathname, '/api/issues/ABC-1');
});

test('request maps 401 to an actionable message', async () => {
  stubFetch(() => ({ status: 401, body: { error: 'nope' } }));
  const r = await request('https://a.cloud', 't', 'api/users/me');
  assert.equal(r.ok, false);
  assert.match(r.error, /authentication failed \(HTTP 401\)/);
});

test('request surfaces the 400 detail rather than swallowing it', async () => {
  // Swallowing this is what turned a parser error into a bare "update failed".
  stubFetch(() => ({ status: 400, body: { error_description: 'expected: {Staging}' } }));
  const r = await request('https://a.cloud', 't', 'api/commands', { method: 'POST', body: {} });
  assert.match(r.error, /expected: \{Staging\}/);
});

// --- the read-back invariant -------------------------------------------------

test('applyCommand reports the state it read back, not the one it asked for', async () => {
  // The commands API returns 200 for commands it did not apply. This is the
  // whole reason the read-back exists.
  stubFetch((url, init) => {
    if (init?.method === 'POST') return { status: 200, body: {} };
    return { body: { customFields: [{ name: 'State', value: { name: 'Open' } }] } };
  });

  const r = await applyCommand('https://a.cloud', 't', 'ABC-1', 'State {In Review}');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'Open', 'a 200 that applied nothing must still report the real state');
});

test('applyCommand reports the new state when the command did apply', async () => {
  stubFetch((url, init) => {
    if (init?.method === 'POST') return { status: 200, body: {} };
    return { body: { customFields: [{ name: 'State', value: { name: 'In Review' } }] } };
  });
  const r = await applyCommand('https://a.cloud', 't', 'ABC-1', 'State {In Review}');
  assert.equal(r.state, 'In Review');
});

test('applyCommand fails loudly when the command is rejected', async () => {
  stubFetch(() => ({ status: 400, body: { error_description: 'expected: {Staging}' } }));
  const r = await applyCommand('https://a.cloud', 't', 'ABC-1', 'State {Staging}');
  assert.equal(r.ok, false);
  assert.match(r.error, /expected: \{Staging\}/);
});

test('applyCommand attaches a comment only when given one', async () => {
  const calls = stubFetch((url, init) =>
    init?.method === 'POST' ? { body: {} } : { body: { customFields: [] } });

  await applyCommand('https://a.cloud', 't', 'ABC-1', 'State Done');
  assert.equal(JSON.parse(calls[0].init.body).comment, undefined);

  calls.length = 0;
  await applyCommand('https://a.cloud', 't', 'ABC-1', 'State Done', 'shipped');
  assert.equal(JSON.parse(calls[0].init.body).comment, 'shipped');
});

test('getState returns unknown rather than throwing when the read fails', async () => {
  stubFetch(() => ({ status: 500, body: {} }));
  assert.equal(await getState('https://a.cloud', 't', 'ABC-1'), 'unknown');
});

test('getState returns unknown when the issue has no State field', async () => {
  stubFetch(() => ({ body: { customFields: [{ name: 'Type', value: { name: 'Bug' } }] } }));
  assert.equal(await getState('https://a.cloud', 't', 'ABC-1'), 'unknown');
});
