// POST /api/otp {accountId} → one-time WebSocket URL for that account.
// The OTP is single-use and short-lived, so the page asks for a fresh one on every (re)connect.
const { withSession, readJson, derivFetch, derivError, ACCOUNT_ID_RE } = require('./_lib/http');

module.exports = withSession(async (req, token) => {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const { accountId } = await readJson(req);
  if (!ACCOUNT_ID_RE.test(String(accountId || ''))) return { status: 400, body: { error: 'Invalid account ID' } };

  const r = await derivFetch(token, `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, { method: 'POST' });
  if (!r.ok) return { status: r.status, body: { error: derivError(r.data, 'Could not open a trading connection') } };

  const wsUrl = r.data && r.data.data && r.data.data.url;
  if (!wsUrl) return { status: 502, body: { error: 'Deriv did not return a WebSocket URL' } };
  return { status: 200, body: { url: wsUrl } };
});
