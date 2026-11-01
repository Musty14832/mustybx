// POST /api/reset-demo {accountId} → top the demo account back up.
const { withSession, readJson, derivFetch, derivError, ACCOUNT_ID_RE } = require('./_lib/http');

module.exports = withSession(async (req, token) => {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const { accountId } = await readJson(req);
  if (!ACCOUNT_ID_RE.test(String(accountId || ''))) return { status: 400, body: { error: 'Invalid account ID' } };

  const r = await derivFetch(token, `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/reset-demo-balance`, { method: 'POST' });
  if (!r.ok) return { status: r.status, body: { error: derivError(r.data, 'Could not reset demo balance') } };
  return { status: 200, body: { ok: true, data: r.data && r.data.data } };
});
