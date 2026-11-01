// GET /login  (rewritten from /login in vercel.json)
// Starts the Deriv OAuth 2.0 Authorization Code + PKCE flow.
// Add ?signup=1 to send the user to Deriv's sign-up form instead of login.

const crypto = require('crypto');
const { APP_ID, AUTH_BASE, SCOPES, setCookie, redirect, redirectUri } = require('./_lib/http');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://local');

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  // Short-lived, httpOnly: only the server reads these back in /callback.
  setCookie(req, res, 'mbx_pkce', verifier, { maxAge: 600 });
  setCookie(req, res, 'mbx_state', state, { maxAge: 600 });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: APP_ID,
    redirect_uri: redirectUri(req),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (url.searchParams.get('signup')) params.set('prompt', 'registration');

  redirect(res, `${AUTH_BASE}/oauth2/auth?${params.toString()}`);
};
