// Local stand-in for Deriv's OAuth server, REST API and options WebSockets,
// shaped after developers.deriv.com docs. Test-only; never deployed.
const http = require('http');
const crypto = require('crypto');
const E = require('../public/js/engine.js');

const PORT = Number(process.env.MOCK_PORT || 4100);
const CLIENT_ID = process.env.EXPECT_CLIENT_ID || '34QgKaYtPLMtQyvz5UhGx';
const TOKEN = 'ory_at_test_token';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const codes = new Map(); // code -> { challenge, redirect_uri }
const otps = new Set();
const settlements = new Map();
let balance = 10000;
const log = (...a) => { if (process.env.MOCK_VERBOSE) console.log('[mock]', ...a); };
const calls = []; // recorded for assertions

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  calls.push(`${req.method} ${url.pathname}`);
  log(req.method, url.pathname + url.search);

  if (url.pathname === '/__calls') return json(res, 200, calls);

  if (req.method === 'GET' && url.pathname === '/oauth2/auth') {
    const p = url.searchParams;
    const problems = [];
    if (p.get('response_type') !== 'code') problems.push('response_type');
    if (p.get('client_id') !== CLIENT_ID) problems.push('client_id');
    if (p.get('code_challenge_method') !== 'S256') problems.push('code_challenge_method');
    if (!p.get('code_challenge')) problems.push('code_challenge');
    if (!p.get('state')) problems.push('state');
    if (!(p.get('scope') || '').split(' ').includes('trade')) problems.push('scope');
    if (!p.get('redirect_uri')) problems.push('redirect_uri');
    if (problems.length) return json(res, 400, { error: 'invalid_request', problems });
    const code = 'code_' + crypto.randomBytes(6).toString('hex');
    codes.set(code, { challenge: p.get('code_challenge'), redirect_uri: p.get('redirect_uri') });
    const back = new URL(p.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/oauth2/token') {
    const form = new URLSearchParams(await readBody(req));
    const entry = codes.get(form.get('code'));
    if (form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== CLIENT_ID || !entry) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or client' });
    }
    if (form.get('redirect_uri') !== entry.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    const expect = b64url(crypto.createHash('sha256').update(form.get('code_verifier') || '').digest());
    if (expect !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    codes.delete(form.get('code'));
    return json(res, 200, { access_token: TOKEN, expires_in: 2592000, token_type: 'Bearer' });
  }

  if (url.pathname.startsWith('/trading/v1/options/accounts')) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { errors: [{ status: 401, code: 'Unauthorized', message: 'Invalid or missing authentication credentials' }] });
    if (!req.headers['deriv-app-id']) return json(res, 400, { errors: [{ status: 400, code: 'ValidationError', message: 'Deriv-App-ID header is required' }] });
    if (req.method === 'GET' && url.pathname === '/trading/v1/options/accounts') {
      return json(res, 200, { data: [{ account_id: 'DOT90004580', balance, currency: 'USD', group: 'row' }], meta: { endpoint: '/accounts', method: 'GET', timing: 5 } });
    }
    const m = /^\/trading\/v1\/options\/accounts\/([^/]+)\/otp$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const otp = crypto.randomBytes(6).toString('hex');
      otps.add(otp);
      return json(res, 200, { data: { url: `ws://localhost:${PORT}/trading/v1/options/ws/demo?otp=${otp}` }, meta: {} });
    }
    if (req.method === 'POST' && /reset-demo-balance$/.test(url.pathname)) {
      balance = 10000;
      return json(res, 200, { data: { balance }, meta: {} });
    }
  }

  json(res, 404, { error: 'not_found' });
});

// ---------------- minimal WebSocket server (RFC 6455 text frames) ----------------
function sendFrame(socket, text) {
  if (socket.destroyed) return;
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function parseFrames(state, chunk, onText, onClose) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return;
    const mask = masked ? b.slice(off, off + 4) : null;
    const data = Buffer.from(b.slice(off + maskLen, off + maskLen + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    state.buf = b.slice(off + maskLen + len);
    if (opcode === 0x8) return onClose();
    if (opcode === 0x1) onText(data.toString('utf8'));
  }
}

const symbols = new Map(); // live price per symbol
function nextQuote(sym) {
  const q = (symbols.get(sym) || 1000 + Math.random() * 100) + (Math.random() - 0.5) * 2;
  symbols.set(sym, q);
  return Math.round(q * 100) / 100;
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const isPublic = url.pathname === '/trading/v1/options/ws/public';
  const isDemo = url.pathname === '/trading/v1/options/ws/demo';
  if (!isPublic && !(isDemo && otps.delete(url.searchParams.get('otp')))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  log('ws open', url.pathname);

  const st = { buf: Buffer.alloc(0) };
  const timers = new Set();
  const send = (obj) => sendFrame(socket, JSON.stringify(obj));
  let balanceSub = null;
  const tickSubs = new Map();
  const lastDigitBySym = new Map();

  const close = () => { for (const t of timers) clearInterval(t); timers.clear(); socket.destroy(); };
  socket.on('close', close);
  socket.on('error', close);

  socket.on('data', (chunk) => parseFrames(st, chunk, (text) => {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const base = { echo_req: m, req_id: m.req_id };
    calls.push(`WS ${isPublic ? 'public' : 'demo'} ${Object.keys(m).filter((k) => k !== 'req_id')[0]}`);

    if (m.ping) return send({ ...base, msg_type: 'ping', ping: 'pong' });

    if (isPublic && m.ticks_history) {
      const prices = Array.from({ length: Math.min(m.count || 100, 1000) }, () => nextQuote(m.ticks_history));
      return send({ ...base, msg_type: 'history', pip_size: 2, history: { prices, times: prices.map((_, i) => 1700000000 + i) } });
    }
    if (isPublic && m.ticks) {
      const sym = m.ticks;
      const id = crypto.randomBytes(4).toString('hex');
      const t = setInterval(() => {
        const q = nextQuote(sym);
        lastDigitBySym.set(sym, E.lastDigit(q, 2));
        send({ echo_req: m, req_id: m.req_id, msg_type: 'tick', tick: { quote: q, symbol: sym, pip_size: 2, epoch: Math.floor(Date.now() / 1000), id }, subscription: { id } });
      }, 200);
      timers.add(t);
      tickSubs.set(id, t);
      return undefined;
    }
    if (m.forget_all) {
      for (const [, t] of tickSubs) { clearInterval(t); timers.delete(t); }
      tickSubs.clear();
      return send({ ...base, msg_type: 'forget_all', forget_all: [] });
    }
    if (m.forget) return send({ ...base, msg_type: 'forget', forget: 1 });

    if (!isPublic && m.balance) {
      balanceSub = { m, id: 'bal1' };
      return send({ ...base, msg_type: 'balance', balance: { balance, currency: 'USD', loginid: 'DOT90004580' }, subscription: { id: 'bal1' } });
    }

    if (!isPublic && m.buy) {
      const p = m.parameters || {};
      const errs = [];
      if (m.buy !== '1') errs.push('buy must be "1" with parameters');
      if (!(p.amount >= 0.35)) errs.push('amount');
      if (p.basis !== 'stake') errs.push('basis');
      if (!['DIGITDIFF', 'DIGITMATCH', 'DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'].includes(p.contract_type)) errs.push('contract_type');
      if (['DIGITDIFF', 'DIGITMATCH', 'DIGITOVER', 'DIGITUNDER'].includes(p.contract_type) && !/^\d$/.test(String(p.barrier))) errs.push('barrier');
      if (p.duration_unit !== 't' || !(p.duration >= 1 && p.duration <= 10)) errs.push('duration');
      if (!p.underlying_symbol) errs.push('underlying_symbol');
      if (p.symbol) errs.push('legacy field "symbol" sent');
      if (p.currency !== 'USD') errs.push('currency');
      if (typeof m.price !== 'number') errs.push('price');
      if (errs.length) return send({ ...base, msg_type: 'buy', error: { code: 'InputValidationFailed', message: errs.join(', ') } });

      const contractId = Math.floor(Math.random() * 1e9);
      balance = Math.round((balance - p.amount) * 100) / 100;
      send({ ...base, msg_type: 'buy', buy: { balance_after: balance, buy_price: p.amount, contract_id: contractId, longcode: `${p.contract_type} ${p.barrier ?? ''}`, payout: p.amount * 2, purchase_time: Date.now() / 1000, shortcode: 'X', start_time: Date.now() / 1000, transaction_id: contractId + 1 } });
      const mult = { DIGITDIFF: 0.095, DIGITMATCH: 8.0, DIGITEVEN: 0.95, DIGITODD: 0.95, DIGITOVER: 0.6, DIGITUNDER: 0.6 }[p.contract_type];
      const exitQuote = nextQuote(p.underlying_symbol);
      const exitDigit = E.lastDigit(exitQuote, 2);
      const won = E.settles(p.contract_type, p.barrier, exitDigit);
      const profit = won ? Math.round(p.amount * mult * 100) / 100 : -p.amount;
      calls.push(`SETTLE ${p.contract_type} ${p.barrier ?? '-'} exit=${exitDigit} ${won ? 'won' : 'lost'}`);
      settlements.set(contractId, { won, exitDigit, profit, exitQuote });
      setTimeout(() => {
        if (won) balance = Math.round((balance + p.amount + profit) * 100) / 100;
        if (balanceSub) send({ echo_req: balanceSub.m, req_id: balanceSub.m.req_id, msg_type: 'balance', balance: { balance, currency: 'USD' }, subscription: { id: 'bal1' } });
      }, 500);
      return undefined;
    }

    if (!isPublic && m.proposal_open_contract) {
      const sid = 'poc' + m.contract_id;
      const st8 = settlements.get(Number(m.contract_id));
      if (!st8) return send({ ...base, msg_type: 'proposal_open_contract', error: { code: 'ContractNotFound', message: 'unknown contract' } });
      send({ ...base, msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: m.contract_id, contract_type: 'X', currency: 'USD', status: 'open', is_sold: 0 }, subscription: { id: sid } });
      setTimeout(() => {
        send({ ...base, msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: m.contract_id, contract_type: 'X', currency: 'USD', status: st8.won ? 'won' : 'lost', is_sold: 1, profit: String(st8.profit), exit_tick_display_value: st8.exitQuote.toFixed(2) }, subscription: { id: sid } });
      }, 400);
      return undefined;
    }

    return send({ ...base, msg_type: 'error', error: { code: 'UnknownRequest', message: 'mock does not handle this' } });
  }, close));
});

server.listen(PORT, () => console.log(`mock Deriv on http://localhost:${PORT}`));
module.exports = server;
