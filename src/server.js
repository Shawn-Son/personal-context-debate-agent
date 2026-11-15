import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.js';
import { createProvider } from './provider.js';
import {
  HttpError, checkWriteOrigin, isAuthorized, readConfig, readJson, requireChoice, requireString,
  sendJson, setResponseHeaders,
} from './http.js';

const assets = new URL('../public/', import.meta.url);
const mime = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};
const providerTimeout = {
  reply: 45_000,
  review: 95_000,
  connectVoice: 30_000,
};

function requireSession(store, id) {
  const session = store.getSession(id);
  if (!session) throw new HttpError(404, 'Session not found.');
  return session;
}

function requireActive(session) {
  if (session.status !== 'active') throw new HttpError(409, 'This session has already ended.');
}

function normalizeTranscript(events) {
  if (!Array.isArray(events) || events.length > 150) throw new HttpError(400, 'Invalid transcript batch.');
  return events.map((event) => {
    if (!event || typeof event !== 'object') throw new HttpError(400, 'Invalid transcript event.');
    const { startMs, endMs } = event;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || endMs > 86_400_000) {
      throw new HttpError(400, 'Invalid transcript timing.');
    }
    return {
      eventId: requireString(event.eventId, 'event ID', 200),
      role: requireChoice(event.role, 'speaker', ['user', 'assistant']),
      streamId: event.streamId === undefined ? undefined : requireString(event.streamId, 'stream ID', 120),
      text: requireString(event.text, 'transcript text', 1500, { empty: true, keepSpace: true }),
      startMs: Math.floor(startMs),
      endMs: Math.floor(endMs),
    };
  });
}

function sessionContext(store, session) {
  return store.getContext({
    topic: session.topic,
    scope: session.style === 'debate' ? 'debate' : 'general_conversation',
    sessionId: session.id,
  });
}

function reviewWithoutAI(utterances) {
  const count = utterances.filter((utterance) => utterance.role === 'user').length;
  return {
    summary: count
      ? 'Session saved with ' + count + ' learner contributions. Open the transcript to revisit the conversation.'
      : 'This session ended before you made a contribution.',
    openQuestion: '',
    feedback: [],
    candidates: [],
  };
}

export function createApp({ config = readConfig(), store = openStore(config.dbPath), provider = createProvider() } = {}) {
  const pending = new Map();
  const negotiations = [];
  let closing = false;

  async function providerCall(method, params) {
    try {
      return await provider[method]({ ...params, signal: AbortSignal.timeout(providerTimeout[method]) });
    } catch (error) {
      // Upstream bodies may contain user data. Keep both API responses and logs generic.
      if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.status === 504) {
        throw new HttpError(504, 'The model took too long to respond. Try again.');
      }
      if (error.name === 'ProviderError' && Number.isInteger(error.status)) {
        throw new HttpError(error.status, error.message);
      }
      throw new HttpError(502, 'Could not reach the configured model. Check the API settings and try again.');
    }
  }

  async function runSessionTask(id, name, task) {
    const current = pending.get(id);
    if (current) {
      if (current.name === 'end' && name === 'end') return current.promise;
      throw new HttpError(409, 'Another session action is in progress. Try again in a moment.');
    }
    const promise = Promise.resolve().then(task);
    pending.set(id, { name, promise });
    try { return await promise; }
    finally { pending.delete(id); }
  }

  async function api(req, res, path) {
    const method = req.method;
    if (method === 'GET' && path === '/api/status') {
      return sendJson(res, 200, {
        voiceAvailable: provider.voiceAvailable,
        reviewAvailable: provider.reviewAvailable,
        needsBootstrap: store.needsBootstrap(),
      });
    }
    if (path === '/api/memories' && method === 'GET') {
      return sendJson(res, 200, { memories: store.listMemories() });
    }
    const memoryMatch = path.match(/^\/api\/memories\/([\w-]+)$/);
    if (memoryMatch && method === 'PATCH') {
      const { value, version } = await readJson(req);
      const newValue = requireString(value, 'memory value', 2000);
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
        throw new HttpError(400, 'Invalid memory version.');
      }
      const memory = store.patchMemory(memoryMatch[1], { value: newValue, version });
      if (!memory) throw new HttpError(404, 'Memory not found.');
      return sendJson(res, 200, { memory });
    }
    if (memoryMatch && method === 'DELETE') {
      if (!store.deleteMemory(memoryMatch[1])) throw new HttpError(404, 'Memory not found.');
      return sendJson(res, 200, { deleted: true });
    }

    if (path === '/api/sessions' && method === 'GET') {
      return sendJson(res, 200, { sessions: store.listSessions() });
    }
    if (path === '/api/sessions' && method === 'POST') {
      const body = await readJson(req);
      const mode = requireChoice(body.mode, 'session mode', ['bootstrap', 'conversation']);
      const topic = requireString(body.topic ?? '', 'topic', 240, { empty: true });
      const style = requireChoice(body.style ?? 'explore', 'conversation style', ['explore', 'debate']);
      const language = requireChoice(body.language ?? 'en', 'language', ['en', 'ko']);
      const session = store.createSession({ mode, topic, style, language });
      const opening = provider.opening({ session, context: sessionContext(store, session) });
      return sendJson(res, 201, { session, opening });
    }

    const match = path.match(/^\/api\/sessions\/([\w-]+)(?:\/(turns|transcript|end|voice))?$/);
    if (!match) throw new HttpError(404, 'Not found.');
    const [, id, operation] = match;
    const session = requireSession(store, id);

    if (method === 'GET' && !operation) {
      const utterances = store.listUtterances(id);
      const opening = session.status === 'active' && !utterances.length
        ? provider.opening({ session, context: sessionContext(store, session) })
        : undefined;
      return sendJson(res, 200, { session, utterances, opening });
    }
    if (method !== 'POST' || !operation) throw new HttpError(405, 'Method not allowed.');
    const body = await readJson(req);

    if (operation === 'transcript') {
      requireActive(requireSession(store, id));
      if (pending.get(id)?.name === 'end') throw new HttpError(409, 'This session is being finalized.');
      const { accepted } = store.appendUtterances(id, normalizeTranscript(body.events));
      return sendJson(res, 200, { accepted });
    }

    const result = await runSessionTask(id, operation, async () => {
      const current = requireSession(store, id);
      if (operation === 'end' && current.status === 'ended') {
        return { session: current, review: current.review };
      }
      requireActive(current);
      const context = sessionContext(store, current);

      if (operation === 'voice') {
        if (!provider.voiceAvailable) throw new HttpError(503, 'Configure an OpenAI API key to start live voice.');
        const sdp = requireString(body.sdp, 'WebRTC offer', 100_000, { keepSpace: true });
        if (!sdp.startsWith('v=0') || !sdp.includes('m=audio')) throw new HttpError(400, 'Invalid WebRTC audio offer.');
        const now = Date.now();
        while (negotiations.length && negotiations[0] < now - 60_000) negotiations.shift();
        if (negotiations.length >= 12) throw new HttpError(429, 'Too many voice connection attempts. Try again in a minute.');
        negotiations.push(now);
        return providerCall('connectVoice', { sdp, session: current, context, utterances: store.listUtterances(id) });
      }

      if (operation === 'turns') {
        const userText = requireString(body.text, 'message', 8000);
        const utterances = store.listUtterances(id);
        const opening = utterances.length ? [] : [{
          role: 'assistant', text: provider.opening({ session: current, context }),
        }];
        // Store successful exchanges together so a failed model call can be retried.
        const reply = await providerCall('reply', {
          session: current, context,
          utterances: [...opening, ...utterances, { role: 'user', text: userText }],
        });
        return store.appendUtterances(id, [
          ...opening,
          { role: 'user', text: userText },
          { role: 'assistant', text: reply },
        ]);
      }

      const utterances = store.listUtterances(id);
      const rawReview = body.withoutReview === true || !utterances.some((turn) => turn.role === 'user')
        ? reviewWithoutAI(utterances)
        : await providerCall('review', { session: current, context, utterances });
      const { candidates = [], ...review } = rawReview;
      return store.endSession(id, review, candidates);
    });
    return sendJson(res, 200, result);
  }

  const server = createServer(async (req, res) => {
    setResponseHeaders(res);
    try {
      if (closing) throw new HttpError(503, 'The app is restarting.');
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
      if (!isAuthorized(req, config)) {
        if (config.password) res.setHeader('WWW-Authenticate', 'Basic realm="Context Debate", charset="UTF-8"');
        throw new HttpError(config.password ? 401 : 403, config.password ? 'Sign in to access your workspace.' : 'This app is available on localhost.');
      }
      if (pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) checkWriteOrigin(req, config);
        await api(req, res, pathname);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(file)) throw new HttpError(404, 'Not found.');
      const type = mime[file.split('.').at(-1)];
      if (!type) throw new HttpError(404, 'Not found.');
      let buffer;
      try { buffer = await readFile(new URL(file, assets)); }
      catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'Not found.'); throw error; }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buffer.length });
      res.end(req.method === 'HEAD' ? undefined : buffer);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
      if (status === 500) console.error('Request failed:', error.name, error.code || '');
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : error.message });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    async close() {
      closing = true;
      await new Promise((resolve, reject) => server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
      await Promise.allSettled([...pending.values()].map(({ promise }) => promise));
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  const app = createApp({ config });
  app.server.listen(config.port, config.host, () => {
    const address = config.host.includes(':') ? '[' + config.host + ']' : config.host;
    console.log('Context Debate listening on http://' + address + ':' + config.port);
  });
  function stop() {
    const deadline = setTimeout(() => process.exit(1), 105_000);
    deadline.unref();
    app.close().catch(() => { process.exitCode = 1; });
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
