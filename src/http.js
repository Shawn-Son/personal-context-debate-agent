import { createHash, timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 3000);
  const username = env.APP_USERNAME || 'owner';
  const password = env.APP_PASSWORD || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (username.includes(':')) throw new Error('APP_USERNAME must not contain a colon.');
  if ((!LOOPBACK.has(host) || env.NODE_ENV === 'production') && password.length < 16) {
    throw new Error('Set an APP_PASSWORD of at least 16 characters for deployments.');
  }
  const origin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN) : null;
  if (origin && (!['http:', 'https:'].includes(origin.protocol) || origin.href !== origin.origin + '/')) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
  }
  return {
    host, port, username, password, origin,
    dbPath: env.DB_PATH || './data/context-debate.sqlite',
  };
}

export function setResponseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

export function requestHostname(req) {
  try { return new URL('http://' + (req.headers.host || '')).hostname; }
  catch { return ''; }
}

export function isAuthorized(req, config) {
  if (!config.password) return LOOPBACK.has(requestHostname(req));
  const header = req.headers.authorization || '';
  if (!/^Basic /i.test(header) || header.length > 4096) return false;
  const supplied = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(config.username + ':' + config.password);
  const digest = (bytes) => createHash('sha256').update(bytes).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function checkWriteOrigin(req, config) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Open the app directly to make changes.');
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = config.origin
    ? origin === config.origin.origin
    : origin === 'http://' + req.headers.host || origin === 'https://' + req.headers.host;
  if (!allowed) throw new HttpError(403, 'Request origin does not match this app.');
}

export function sendJson(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function readJson(req, maxBytes = 128 * 1024) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Send an application/json request.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      // Drain the rest without buffering it, then close the connection after responding.
      req.resume();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
    return record;
  } catch {
    throw new HttpError(400, 'Send a valid JSON object.');
  }
}

export function requireString(value, label, max, { empty = false, keepSpace = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new HttpError(400, 'Invalid ' + label + '.');
  }
  return keepSpace ? value : value.trim();
}

export function requireChoice(value, label, choices) {
  if (!choices.includes(value)) throw new HttpError(400, 'Invalid ' + label + '.');
  return value;
}
