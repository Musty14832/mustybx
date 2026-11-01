// GET /callback  (rewritten from /callback in vercel.json)
// Deriv redirects here with ?code&state. We exchange the code for an access
// token on the server (Deriv requires this to happen off the browser) and keep
// the token in an httpOnly cookie so page JavaScript never sees it.

const {
  APP_ID, AUTH_BASE, TOKEN_COOKIE, EXP_COOKIE,
  parseCookies, setCookie, clearCookie, redirect, redirectUri,
} = require('./_lib/http');

const fail = (req, res, code, detail) => {
  clearCookie(req, res, 'mbx_pkce');
  clearCookie(req, res, 'mbx_state');
  const q = new URLSearchParams({ error: code });
  if (detail) q.set('detail', String(detail).slice(0, 200));
  redirect(res, `/?${q.toString()}`);
};

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const q = url.searchParams;

  if (q.get('error')) return fail(req, res, q.get('error'), q.get('error_description'));

  const cookies = parseCookies(req);
  const code = q.get('code');
  const state = q.get('state');
  if (!code) return fail(req, res, 'missing_code');
  if (!state || !cookies.mbx_state || state !== cookies.mbx_state) return fail(req, res, 'state_mismatch');
  if (!cookies.mbx_pkce) return fail(req, res, 'missing_verifier');

  let data = {};
  let ok = false;
  try {
    const r = await fetch(`${AUTH_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: APP_ID,
        code,
        code_verifier: cookies.mbx_pkce,
        redirect_uri: redirectUri(req),
      }).toString(),
    });
    ok = r.ok;
    data = await r.json().catch(() => ({}));
  } catch (err) {
    return fail(req, res, 'token_request_failed', err && err.message);
  }

  if (!ok || !data.access_token) {
    return fail(req, res, 'token_exchange_failed', data.error_description || data.error);
  }

  // No refresh token on Deriv's new API: when this expires the user logs in again.
  const expiresIn = Math.max(60, Math.min(Number(data.expires_in) || 3600, 60 * 60 * 24 * 30));
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  clearCookie(req, res, 'mbx_pkce');
  clearCookie(req, res, 'mbx_state');
  setCookie(req, res, TOKEN_COOKIE, data.access_token, { maxAge: expiresIn });
  setCookie(req, res, EXP_COOKIE, String(expiresAt), { maxAge: expiresIn, httpOnly: false });

  redirect(res, '/app');
};
