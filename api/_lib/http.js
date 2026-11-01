// Shared helpers for the Vercel serverless functions.
// Zero dependencies: only Node built-ins and global fetch (Node 18+).

const APP_ID = process.env.DERIV_APP_ID || '34QgKaYtPLMtQyvz5UhGx';
const AUTH_BASE = (process.env.DERIV_AUTH_BASE || 'https://auth.deriv.com').replace(/\/$/, '');
const API_BASE = (process.env.DERIV_API_BASE || 'https://api.derivws.com').replace(/\/$/, '');
const PUBLIC_WS = process.env.DERIV_PUBLIC_WS || 'wss://api.derivws.com/trading/v1/options/ws/public';
const SCOPES = process.env.DERIV_SCOPES || 'trade account_manage';

const TOKEN_COOKIE = 'mbx_token';
const EXP_COOKIE = 'mbx_exp';

function hostOf(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
}

function isLocal(req) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostOf(req));
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (isLocal(req) ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${hostOf(req)}`;
}

// Must match the Redirect URL registered on developers.deriv.com exactly.
function redirectUri(req) {
  return process.env.DERIV_REDIRECT_URI || `${originOf(req)}/callback`;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  });
  return out;
}

function setCookie(req, res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (!isLocal(req)) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(req, res, name) {
  setCookie(req, res, name, '', { maxAge: 0 });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

async function readJson(req) {
  // On Vercel, req.body may already be parsed; locally we read the stream.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body || '{}'); } catch { return {}; }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { return {}; }
    }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

// Block cross-site POSTs (cookies are SameSite=Lax already; this is belt and braces).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === hostOf(req);
  } catch {
    return false;
  }
}

function getToken(req) {
  return parseCookies(req)[TOKEN_COOKIE] || null;
}

async function derivFetch(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Deriv-App-ID': APP_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, ok: r.ok, data };
}

function derivError(data, fallback) {
  const e = data && Array.isArray(data.errors) && data.errors[0];
  return (e && (e.message || e.code)) || (data && data.error_description) || fallback;
}

// Wraps a handler: requires a session, clears it if Deriv says the token is dead.
// The handler returns { status, body }; the wrapper sends it.
function withSession(handler) {
  return async (req, res) => {
    const token = getToken(req);
    if (!token) return sendJson(res, 401, { error: 'not_logged_in' });
    if (req.method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'bad_origin' });
    try {
      const { status, body } = await handler(req, token);
      if (status === 401) {
        clearCookie(req, res, TOKEN_COOKIE);
        clearCookie(req, res, EXP_COOKIE);
        return sendJson(res, 401, { error: 'session_expired' });
      }
      return sendJson(res, status, body);
    } catch (err) {
      return sendJson(res, 502, { error: 'upstream_error', message: String((err && err.message) || err) });
    }
  };
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;

module.exports = {
  APP_ID, AUTH_BASE, API_BASE, PUBLIC_WS, SCOPES, TOKEN_COOKIE, EXP_COOKIE, ACCOUNT_ID_RE,
  parseCookies, setCookie, clearCookie, sendJson, redirect, readJson, sameOrigin,
  getToken, derivFetch, derivError, withSession, redirectUri, isLocal,
};
