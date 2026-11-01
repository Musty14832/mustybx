// GET /api/session — is the visitor logged in? Also hands the page the public
// market-data WebSocket URL so it isn't hardcoded in the browser bundle.
const { PUBLIC_WS, EXP_COOKIE, getToken, parseCookies, sendJson } = require('./_lib/http');

module.exports = async (req, res) => {
  const token = getToken(req);
  const exp = Number(parseCookies(req)[EXP_COOKIE]) || null;
  sendJson(res, 200, { loggedIn: Boolean(token), expiresAt: token ? exp : null, publicWs: PUBLIC_WS });
};
