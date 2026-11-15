import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { readConfig } from '../src/http.js';
import { createProvider } from '../src/provider.js';

async function fixture(t, options = {}) {
  const config = { ...readConfig({}), dbPath: ':memory:', ...options.config };
  const app = createApp({ config, provider: options.provider || createProvider({ apiKey: '' }) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  function request(path, method = 'GET', body, headers = {}) {
    return fetch(base + path, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function json(path, method, body, expected = 200) {
    const response = await request(path, method, body);
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  return { json, request };
}

test('offline onboarding and conversation support a complete learner session', async (t) => {
  const { json } = await fixture(t);
  assert.deepEqual(await json('/api/status'), {
    voiceAvailable: false, reviewAvailable: false, needsBootstrap: true,
  });
  const { session, opening } = await json('/api/sessions', 'POST', { mode: 'bootstrap' }, 201);
  assert.ok(opening);
  const path = '/api/sessions/' + session.id;
  await json(path + '/turns', 'POST', { text: 'I want to discuss engineering decisions in English.' });
  const history = await json(path);
  assert.equal(history.utterances.filter(({ role }) => role === 'user').length, 1);

  const ended = await json(path + '/end', 'POST', {});
  assert.equal(ended.session.status, 'ended');
  assert.ok(ended.review.summary);
  assert.deepEqual(await json(path + '/end', 'POST', {}), ended);
  assert.equal((await json('/api/status')).needsBootstrap, false);
  await json(path + '/turns', 'POST', { text: 'Too late' }, 409);
});

test('voice transcript persists once and only valid evidence updates future context', async (t) => {
  let nextContext;
  const provider = {
    voiceAvailable: true, reviewAvailable: true,
    opening({ context }) { nextContext = context; return 'Let’s talk.'; },
    async connectVoice({ sdp }) { assert.match(sdp, /m=audio/); return { sdp: 'answer' }; },
    async review({ utterances }) {
      const source = utterances.find((turn) => turn.role === 'user');
      return {
        summary: 'Discussed feedback timing.', openQuestion: 'When is feedback most useful?', feedback: [],
        candidates: [{
          kind: 'preference', key: 'feedback.timing', value: 'after_session', scope: 'general_conversation',
          operation: 'add', assertion: 'explicit', evidenceIds: [source.id],
        }, {
          kind: 'interest', key: 'piano', value: 'piano', scope: 'general_conversation',
          operation: 'add', assertion: 'explicit', evidenceIds: ['missing-id'],
        }],
      };
    },
  };
  const { json } = await fixture(t, { provider });
  const { session } = await json('/api/sessions', 'POST', { mode: 'conversation' }, 201);
  const path = '/api/sessions/' + session.id;
  assert.equal((await json(path + '/voice', 'POST', { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' })).sdp, 'answer');
  const events = [{ eventId: 'evt-1', role: 'user', text: 'I prefer feedback after we finish.', startMs: 100, endMs: 400 }];
  assert.equal((await json(path + '/transcript', 'POST', { events })).accepted, 1);
  assert.equal((await json(path + '/transcript', 'POST', { events })).accepted, 0);
  await json(path + '/end', 'POST', {});
  const { memories } = await json('/api/memories');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].value, 'after_session');
  assert.match(memories[0].evidence[0].quote, /after we finish/);

  const { memory } = await json('/api/memories/' + memories[0].id, 'PATCH', { value: 'on_request', version: memories[0].version });
  assert.equal(memory.value, 'on_request');
  await json('/api/memories/' + memories[0].id, 'PATCH', { value: 'stale', version: memories[0].version }, 409);
  await json('/api/sessions', 'POST', { mode: 'conversation' }, 201);
  assert.equal(nextContext.memories[0].value, 'on_request');
  await json('/api/memories/' + memories[0].id, 'DELETE');
  await json('/api/sessions', 'POST', { mode: 'conversation' }, 201);
  assert.equal(nextContext.memories.length, 0);
});

test('deployed workspace requires credentials and rejects cross-origin writes', async (t) => {
  const config = { password: 'use-a-long-test-password', origin: new URL('https://debate.example.test') };
  const { request } = await fixture(t, { config });
  const auth = 'Basic ' + Buffer.from('owner:' + config.password).toString('base64');
  assert.equal((await request('/health')).status, 200);
  const denied = await request('/api/status');
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('WWW-Authenticate'), /Basic/);
  assert.equal((await request('/api/status', 'GET', undefined, { Authorization: auth })).status, 200);

  const body = { mode: 'conversation' };
  const blocked = await request('/api/sessions', 'POST', body, {
    Authorization: auth, Origin: 'https://example.test',
  });
  assert.equal(blocked.status, 403);
  const allowed = await request('/api/sessions', 'POST', body, {
    Authorization: auth, Origin: config.origin.origin,
  });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.headers.get('Cache-Control'), 'no-store');
});
