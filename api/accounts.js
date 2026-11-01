// GET  /api/accounts                      → list the user's Options trading accounts
// POST /api/accounts {account_type}        → create a demo or real USD account
const { withSession, readJson, derivFetch, derivError } = require('./_lib/http');

module.exports = withSession(async (req, token) => {
  if (req.method === 'GET') {
    const r = await derivFetch(token, '/trading/v1/options/accounts');
    if (!r.ok) return { status: r.status, body: { error: derivError(r.data, 'Could not load accounts') } };
    const list = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
    return { status: 200, body: { accounts: list } };
  }

  if (req.method === 'POST') {
    const { account_type } = await readJson(req);
    if (!['demo', 'real'].includes(account_type)) return { status: 400, body: { error: 'account_type must be demo or real' } };
    const r = await derivFetch(token, '/trading/v1/options/accounts', {
      method: 'POST',
      body: { currency: 'USD', group: 'row', account_type },
    });
    if (!r.ok) return { status: r.status, body: { error: derivError(r.data, 'Could not create account') } };
    return { status: 200, body: { account: r.data && r.data.data } };
  }

  return { status: 405, body: { error: 'method_not_allowed' } };
});
