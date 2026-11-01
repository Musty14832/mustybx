/* Musty BX dashboard — wires the Deriv sockets, the digit engine and the UI. */
(function () {
  'use strict';

  const E = window.DigitEngine;
  const $ = (id) => document.getElementById(id);

  const SYMBOLS = [
    ['1HZ10V', 'Volatility 10 (1s)'], ['R_10', 'Volatility 10'],
    ['1HZ25V', 'Volatility 25 (1s)'], ['R_25', 'Volatility 25'],
    ['1HZ50V', 'Volatility 50 (1s)'], ['R_50', 'Volatility 50'],
    ['1HZ75V', 'Volatility 75 (1s)'], ['R_75', 'Volatility 75'],
    ['1HZ100V', 'Volatility 100 (1s)'], ['R_100', 'Volatility 100'],
  ];
  const MIN_STAKE = 0.35;
  const MAX_DIGITS = 2000;

  // ---------- persistence (best effort) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mbx_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('mbx_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------- state ----------
  const state = {
    publicWs: null,
    accounts: [],
    account: null,
    mode: null, // 'demo' | 'real'
    currency: 'USD',
    balance: null,
    symbol: store.get('symbol', '1HZ100V'),
    pip: 2,
    digits: [],
    lastQuote: null,
    analysis: null,
    sig: null,
    inFlight: null,
    log: [],
    stats: { trades: 0, wins: 0, losses: 0, pl: 0 },
    status: { pub: 'idle', trade: 'idle' },
  };

  const bot = { running: false, baseStake: 1, stake: 1, step: 0, pl: 0, trades: 0 };

  let pub = null;
  let trade = null;

  // ---------- helpers ----------
  const money = (n) => (Number(n) || 0).toFixed(2);
  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const pct = (p) => (p * 100).toFixed(1) + '%';

  let noticeTimer = null;
  function notice(text, kind = 'info', sticky = false) {
    const el = $('notice');
    el.textContent = text;
    el.className = 'notice ' + kind;
    el.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) noticeTimer = setTimeout(() => { el.hidden = true; }, 7000);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (r.status === 401) {
      stopBot('Session expired');
      sessionExpired();
      const err = new Error('Your Deriv session has expired. Please log in again.');
      err.fatal = true;
      throw err;
    }
    if (!r.ok) throw new Error(data.error || data.message || `Request failed (${r.status})`);
    return data;
  }

  function sessionExpired() {
    const el = $('notice');
    el.className = 'notice error';
    el.hidden = false;
    el.textContent = '';
    el.append('Your Deriv session has expired. ');
    const a = document.createElement('a');
    a.href = '/login';
    a.textContent = 'Log in again';
    el.append(a);
  }

  // ---------- connection status ----------
  function setStatus(which, s) {
    state.status[which] = s;
    const dot = $('connDot');
    const all = [state.status.pub, state.status.trade];
    let cls = 'dot ';
    if (all.every((x) => x === 'open')) cls += 'ok';
    else if (all.some((x) => x === 'error')) cls += 'bad';
    else cls += 'wait';
    dot.className = cls;
    dot.title = `Market data: ${state.status.pub} · Trading: ${state.status.trade}`;
  }

  // ---------- accounts ----------
  function accountType(acc) {
    const t = String(acc.account_type || acc.type || '').toLowerCase();
    if (t === 'demo' || t === 'real') return t;
    if (acc.is_virtual === 1 || acc.is_virtual === true) return 'demo';
    return null;
  }

  async function loadAccounts() {
    const { accounts } = await api('/api/accounts');
    state.accounts = accounts || [];
    const sel = $('accountSelect');
    sel.textContent = '';
    if (!state.accounts.length) {
      $('noAccount').hidden = false;
      $('dash').hidden = true;
      return;
    }
    $('noAccount').hidden = true;
    $('dash').hidden = false;
    for (const acc of state.accounts) {
      const o = document.createElement('option');
      o.value = acc.account_id;
      const t = accountType(acc);
      o.textContent = `${t ? t.toUpperCase() + ' · ' : ''}${acc.account_id}`;
      sel.append(o);
    }
    const saved = store.get('account', null);
    const pick = state.accounts.find((a) => a.account_id === saved)
      || state.accounts.find((a) => accountType(a) === 'demo')
      || state.accounts[0];
    sel.value = pick.account_id;
    selectAccount(pick.account_id);
  }

  function renderMode() {
    const b = $('modeBadge');
    b.textContent = state.mode ? state.mode.toUpperCase() : '…';
    b.className = 'badge ' + (state.mode === 'real' ? 'real' : state.mode === 'demo' ? 'demo' : '');
    $('realAck').hidden = state.mode !== 'real';
    $('resetDemo').hidden = state.mode !== 'demo';
    if (state.mode !== 'real') $('realAckBox').checked = false;
  }

  function renderBalance() {
    $('balance').textContent = state.balance === null ? '—' : `${money(state.balance)} ${state.currency}`;
  }

  function selectAccount(id) {
    stopBot();
    const acc = state.accounts.find((a) => a.account_id === id);
    if (!acc) return;
    store.set('account', id);
    state.account = acc;
    state.mode = accountType(acc);
    state.currency = acc.currency || 'USD';
    state.balance = typeof acc.balance === 'number' ? acc.balance : null;
    state.inFlight = null;
    renderMode();
    renderBalance();

    if (trade) trade.close();
    trade = new window.DerivSocket('Trading', async () => {
      const { url } = await api('/api/otp', { method: 'POST', body: { accountId: id } });
      const m = /\/ws\/(demo|real)\b/.exec(url);
      if (m) { state.mode = m[1]; renderMode(); }
      return url;
    }, {
      onOpen: onTradeOpen,
      onMessage: onTradeMessage,
      onStatus: (s, detail) => {
        setStatus('trade', s);
        if (s === 'error' && detail) notice(detail, 'error');
      },
    });
    trade.connect();
  }

  function onTradeOpen() {
    trade.post({ balance: 1, subscribe: 1 });
    // If a contract was running when the connection dropped, pick it back up.
    if (state.inFlight && state.inFlight.id) {
      trade.post({ proposal_open_contract: 1, contract_id: state.inFlight.id, subscribe: 1 });
    }
  }

  function onTradeMessage(msg) {
    if (msg.error && msg.msg_type !== 'buy') {
      if (msg.msg_type === 'balance' || msg.msg_type === 'proposal_open_contract') notice(msg.error.message || 'Trading error', 'error');
      return;
    }
    if (msg.msg_type === 'balance' && msg.balance) {
      state.balance = Number(msg.balance.balance);
      if (msg.balance.currency) state.currency = msg.balance.currency;
      renderBalance();
    } else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
      onContract(msg.proposal_open_contract, msg.subscription && msg.subscription.id);
    }
  }

  // ---------- market data ----------
  function startPublic() {
    pub = new window.DerivSocket('Market data', async () => state.publicWs, {
      onOpen: () => subscribeSymbol(state.symbol),
      onMessage: onPublicMessage,
      onStatus: (s) => setStatus('pub', s),
    });
    pub.connect();
  }

  function subscribeSymbol(sym) {
    state.symbol = sym;
    store.set('symbol', sym);
    state.digits = [];
    state.analysis = null;
    state.sig = null;
    renderMarket();
    renderSignal();
    if (!pub || !pub.isOpen) return;
    pub.post({ forget_all: 'ticks' });
    pub.post({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' });
    pub.post({ ticks: sym, subscribe: 1 });
  }

  function onPublicMessage(msg) {
    if (msg.error) {
      if (msg.msg_type === 'ticks_history' || msg.msg_type === 'history' || msg.msg_type === 'tick') notice(msg.error.message || 'Market data error', 'error');
      return;
    }
    if (msg.msg_type === 'history' && msg.history) {
      const sym = msg.echo_req && msg.echo_req.ticks_history;
      if (sym && sym !== state.symbol) return;
      if (typeof msg.pip_size === 'number') state.pip = msg.pip_size;
      const prices = msg.history.prices || [];
      const seeded = prices.map((p) => E.lastDigit(p, state.pip));
      // Keep any live ticks that raced ahead of the history reply.
      state.digits = seeded.concat(state.digits).slice(-MAX_DIGITS);
      if (prices.length) state.lastQuote = Number(prices[prices.length - 1]);
      update();
    } else if (msg.msg_type === 'tick' && msg.tick) {
      const t = msg.tick;
      const sym = t.symbol || t.underlying_symbol || (msg.echo_req && msg.echo_req.ticks);
      if (sym && sym !== state.symbol) return;
      if (typeof t.pip_size === 'number') state.pip = t.pip_size;
      state.lastQuote = Number(t.quote);
      state.digits.push(E.lastDigit(t.quote, state.pip));
      if (state.digits.length > MAX_DIGITS) state.digits.splice(0, state.digits.length - MAX_DIGITS);
      update();
      maybeAutoTrade();
    }
  }

  // ---------- analysis + rendering ----------
  function strategy() { return $('strategySelect').value; }

  function update() {
    state.analysis = E.analyze(state.digits, { window: parseInt($('windowSelect').value, 10) || 500 });
    state.sig = E.signal(state.analysis, strategy(), $('barrierSelect').value);
    renderMarket();
    renderSignal();
  }

  function renderMarket() {
    $('price').textContent = state.lastQuote === null ? '—' : state.lastQuote.toFixed(state.pip);
    const last = state.digits.length ? state.digits[state.digits.length - 1] : null;
    const ld = $('lastDigit');
    ld.textContent = last === null ? '–' : String(last);
    ld.className = 'digit-big ' + (last === null ? '' : last % 2 ? 'odd' : 'even');
    const strip = $('digitStrip');
    strip.textContent = '';
    for (const d of state.digits.slice(-24)) {
      const s = document.createElement('span');
      s.className = 'chip ' + (d % 2 ? 'odd' : 'even');
      s.textContent = d;
      strip.append(s);
    }
    $('tickCount').textContent = `${state.digits.length} ticks loaded`;
  }

  function highlightSet(sig) {
    if (!sig) return new Set();
    const b = parseInt(sig.barrier, 10);
    switch (sig.contract_type) {
      case 'DIGITDIFF':
      case 'DIGITMATCH': return new Set([b]);
      case 'DIGITEVEN': return new Set([0, 2, 4, 6, 8]);
      case 'DIGITODD': return new Set([1, 3, 5, 7, 9]);
      case 'DIGITOVER': return new Set([...Array(10).keys()].filter((d) => d > b));
      case 'DIGITUNDER': return new Set([...Array(10).keys()].filter((d) => d < b));
      default: return new Set();
    }
  }

  function renderSignal() {
    const a = state.analysis;
    const sig = state.sig;
    const bars = $('digitBars');
    bars.textContent = '';
    const table = $('layerTable');
    table.textContent = '';

    if (!a || !sig) {
      $('signalLabel').textContent = state.digits.length ? `Collecting ticks (${state.digits.length}/30)…` : 'Waiting for ticks…';
      $('confValue').textContent = '0';
      $('confBar').style.width = '0%';
      $('signalOdds').textContent = '';
      $('streakInfo').textContent = '';
      $('entropyInfo').textContent = '';
      return;
    }

    $('signalLabel').textContent = sig.label;
    $('confValue').textContent = String(sig.confidence);
    const bar = $('confBar');
    bar.style.width = sig.confidence + '%';
    bar.className = 'meter-fill ' + (sig.confidence >= 70 ? 'hi' : sig.confidence >= 40 ? 'mid' : 'lo');
    $('signalOdds').textContent = `Model win chance ${pct(sig.modelWin)} vs ${pct(sig.baseline)} by pure chance`;
    const st = a.streak;
    $('streakInfo').textContent = `Streaks: digit ${st.digit} ×${st.length} · ${st.parity} ×${st.parityLength} · ${st.side} ×${st.sideLength}`;
    $('entropyInfo').textContent = `Entropy ${a.entropy.toFixed(3)}`;

    const marks = highlightSet(sig);
    const maxP = Math.max(...a.combined);
    a.combined.forEach((p, d) => {
      const col = document.createElement('div');
      col.className = 'bar-col' + (marks.has(d) ? ' pick' : '');
      const val = document.createElement('div');
      val.className = 'bar-val';
      val.textContent = (p * 100).toFixed(1);
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.height = Math.max(4, (p / maxP) * 100) + '%';
      track.append(fill);
      const lab = document.createElement('div');
      lab.className = 'bar-lab';
      lab.textContent = d;
      const freq = document.createElement('div');
      freq.className = 'bar-freq';
      freq.textContent = ((a.counts[d] / a.n) * 100).toFixed(0) + '%';
      freq.title = 'Share of this digit in the window';
      col.append(val, track, lab, freq);
      bars.append(col);
    });

    const L = a.layers;
    const top = (dist) => dist.indexOf(Math.max(...dist));
    const rows = [
      ['frequency', top(L.frequency.dist), `most ${top(L.frequency.dist)} (${pct(Math.max(...L.frequency.dist))}), least ${L.frequency.dist.indexOf(Math.min(...L.frequency.dist))} (${pct(Math.min(...L.frequency.dist))})`],
      ['recency', top(L.recency.dist), 'weights the last ~50 ticks most'],
      ['gap', top(L.gap.dist), `digit ${top(L.gap.dist)} unseen for ${L.gap.gaps[top(L.gap.dist)]} ticks`],
      ['cycle', L.cycle.predicted === null ? '—' : L.cycle.predicted, L.cycle.lag ? `repeats every ${L.cycle.lag} ticks (${pct(L.cycle.rate)} match)` : 'no repeating cycle found'],
      ['entropy', L.entropy.orderliness > 0 ? top(L.entropy.dist) : '—', `last 25 ticks ${L.entropy.shortEntropy.toFixed(2)} · orderliness ${pct(L.entropy.orderliness)}`],
      ['transition', top(L.transition.dist), `after a ${L.transition.last}, ${top(L.transition.dist)} follows most`],
    ];
    for (const [key, lean, note] of rows) {
      const tr = document.createElement('tr');
      for (const text of [E.LAYER_LABELS[key], String(lean), note]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      table.append(tr);
    }
  }

  // ---------- trading ----------
  function readStake() { return round2(num('stake', 1)); }
  function readTicks() { return Math.min(10, Math.max(1, Math.round(num('ticks', 1)))); }

  function realMoneyBlocked() {
    if (state.mode === 'real' && !$('realAckBox').checked) {
      notice('Tick “I understand this account uses real money” before trading on a real account.', 'error');
      return true;
    }
    return false;
  }

  async function placeTrade(sig, source) {
    if (state.inFlight) { if (source === 'manual') notice('A contract is still running.', 'info'); return; }
    if (!sig) { notice('No signal yet — wait for more ticks.', 'info'); return; }
    if (!trade || !trade.isOpen) { notice('Trading connection is not ready yet.', 'error'); return; }
    if (realMoneyBlocked()) { stopBot(); return; }

    const stake = source === 'auto' ? bot.stake : readStake();
    if (!(stake >= MIN_STAKE)) { notice(`Minimum stake is ${MIN_STAKE}.`, 'error'); stopBot(); return; }
    if (state.balance !== null && stake > state.balance) { notice('Stake is higher than your balance.', 'error'); stopBot('Not enough balance'); return; }

    const parameters = {
      amount: stake,
      basis: 'stake',
      contract_type: sig.contract_type,
      currency: state.currency,
      duration: readTicks(),
      duration_unit: 't',
      underlying_symbol: state.symbol,
    };
    if (sig.barrier !== null && sig.barrier !== undefined) parameters.barrier = String(sig.barrier);

    state.inFlight = { id: null, at: Date.now() };
    renderBotState();
    try {
      const r = await trade.send({ buy: '1', price: stake, parameters });
      const b = r.buy;
      const row = {
        id: b.contract_id,
        time: new Date(),
        label: `${sig.label} · ${state.symbol}`,
        stake: Number(b.buy_price) || stake,
        status: 'open',
        exit: '',
        profit: null,
        source,
      };
      state.log.unshift(row);
      if (state.log.length > 100) state.log.length = 100;
      renderLog();
      if (typeof b.balance_after === 'number') { state.balance = b.balance_after; renderBalance(); }
      state.inFlight = { id: b.contract_id, row, at: Date.now() };
      state.inFlight.timer = setTimeout(() => {
        // Safety net: never let the bot hang forever on one contract.
        if (state.inFlight && state.inFlight.id === b.contract_id) {
          row.status = 'unknown';
          renderLog();
          state.inFlight = null;
          stopBot('No result received for a contract — check Deriv statement');
        }
      }, 120000);
      trade.post({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
    } catch (err) {
      state.inFlight = null;
      renderBotState();
      notice('Trade failed: ' + err.message, 'error');
      stopBot('Stopped after a failed trade');
    }
  }

  function exitDigitOf(c) {
    const disp = c.exit_tick_display_value || c.exit_spot_display_value || c.sell_spot_display_value;
    if (disp !== undefined && disp !== null && String(disp).length) {
      const s = String(disp);
      return { text: s, digit: s.charCodeAt(s.length - 1) - 48 };
    }
    const v = c.exit_tick !== undefined ? c.exit_tick : c.exit_spot !== undefined ? c.exit_spot : c.sell_spot;
    if (v === undefined || v === null) return { text: '', digit: null };
    const d = E.lastDigit(v, state.pip);
    return { text: Number(v).toFixed(state.pip), digit: d };
  }

  function onContract(c, subId) {
    const id = Number(c.contract_id);
    const row = state.log.find((r) => Number(r.id) === id);
    const finished = Number(c.is_sold) === 1 || ['won', 'lost', 'sold'].includes(String(c.status));
    if (!finished) return;
    if (subId) trade.post({ forget: subId });
    if (!row || row.status !== 'open') return;

    const profit = Number(c.profit);
    const ex = exitDigitOf(c);
    row.profit = Number.isFinite(profit) ? profit : 0;
    row.status = row.profit > 0 ? 'won' : 'lost';
    row.exit = ex.digit === null ? '' : String(ex.digit);

    state.stats.trades++;
    if (row.status === 'won') state.stats.wins++; else state.stats.losses++;
    state.stats.pl = round2(state.stats.pl + row.profit);
    renderLog();
    renderStats();

    if (state.inFlight && state.inFlight.id === id) {
      clearTimeout(state.inFlight.timer);
      state.inFlight = null;
    }
    if (row.source === 'auto' && bot.running) afterBotTrade(row.profit);
    renderBotState();
  }

  function renderStats() {
    const s = state.stats;
    $('stTrades').textContent = s.trades;
    $('stWins').textContent = s.wins;
    $('stLosses').textContent = s.losses;
    $('stRate').textContent = s.trades ? ((s.wins / s.trades) * 100).toFixed(1) + '%' : '—';
    const pl = $('stPL');
    pl.textContent = (s.pl > 0 ? '+' : '') + money(s.pl);
    pl.className = s.pl > 0 ? 'pos' : s.pl < 0 ? 'neg' : '';
  }

  function renderLog() {
    const body = $('tradeLog');
    body.textContent = '';
    if (!state.log.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'No trades yet';
      tr.append(td);
      body.append(tr);
      return;
    }
    for (const r of state.log.slice(0, 50)) {
      const tr = document.createElement('tr');
      tr.className = r.status;
      const cells = [
        r.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        r.label + (r.source === 'auto' ? ' · auto' : ''),
        money(r.stake),
        r.exit,
        r.status === 'open' ? '…' : r.status === 'unknown' ? '?' : (r.profit > 0 ? '+' : '') + money(r.profit),
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      body.append(tr);
    }
  }

  // ---------- auto-trader ----------
  function renderBotState() {
    const badge = $('botState');
    const btn = $('autoBtn');
    if (bot.running) {
      badge.textContent = state.inFlight ? 'Trading…' : 'Auto on';
      badge.className = 'badge on';
      btn.textContent = 'Stop auto-trade';
      btn.className = 'btn wide stop';
    } else {
      badge.textContent = state.inFlight ? 'Trading…' : 'Idle';
      badge.className = 'badge';
      btn.textContent = 'Start auto-trade';
      btn.className = 'btn wide';
    }
  }

  function startBot() {
    if (realMoneyBlocked()) return;
    const stake = readStake();
    if (!(stake >= MIN_STAKE)) { notice(`Minimum stake is ${MIN_STAKE}.`, 'error'); return; }
    bot.running = true;
    bot.baseStake = stake;
    bot.stake = stake;
    bot.step = 0;
    bot.pl = 0;
    bot.trades = 0;
    $('autoStatus').textContent = 'Auto-trade on — waiting for a strong enough signal.';
    renderBotState();
    maybeAutoTrade();
  }

  function stopBot(reason) {
    if (!bot.running) { renderBotState(); return; }
    bot.running = false;
    $('autoStatus').textContent = reason ? `Stopped: ${reason}. Session P/L ${money(bot.pl)} over ${bot.trades} trades.` : `Stopped. Session P/L ${money(bot.pl)} over ${bot.trades} trades.`;
    if (reason) notice(`Auto-trade stopped: ${reason}`, 'info');
    renderBotState();
  }

  function maybeAutoTrade() {
    if (!bot.running || state.inFlight || !state.sig) return;
    const minConf = num('minConf', 50);
    if (state.sig.confidence < minConf) {
      $('autoStatus').textContent = `Waiting: confidence ${state.sig.confidence} < ${minConf}. Session P/L ${money(bot.pl)} · ${bot.trades} trades · next stake ${money(bot.stake)}`;
      return;
    }
    $('autoStatus').textContent = `Placing ${state.sig.label} for ${money(bot.stake)}…`;
    placeTrade(state.sig, 'auto');
  }

  function afterBotTrade(profit) {
    bot.trades++;
    bot.pl = round2(bot.pl + profit);

    const useMart = $('martingale').checked;
    if (profit < 0 && useMart) {
      const maxSteps = Math.max(1, Math.round(num('martSteps', 3)));
      if (bot.step < maxSteps) {
        bot.step++;
        bot.stake = round2(bot.stake * Math.max(1, num('martMult', 2)));
      } else {
        bot.step = 0;
        bot.stake = bot.baseStake;
      }
    } else {
      bot.step = 0;
      bot.stake = bot.baseStake;
    }

    const tp = num('takeProfit', 0);
    const sl = num('stopLoss', 0);
    const maxTrades = Math.max(1, Math.round(num('maxTrades', 20)));
    if (tp > 0 && bot.pl >= tp) return stopBot(`take profit reached (+${money(bot.pl)})`);
    if (sl > 0 && bot.pl <= -sl) return stopBot(`stop loss reached (${money(bot.pl)})`);
    if (sl > 0 && bot.pl - bot.stake < -sl) return stopBot(`next stake ${money(bot.stake)} would break the stop loss`);
    if (bot.trades >= maxTrades) return stopBot(`max trades reached (${bot.trades})`);
    $('autoStatus').textContent = `Session P/L ${money(bot.pl)} · ${bot.trades} trades · next stake ${money(bot.stake)}`;
  }

  // ---------- settings ----------
  const SETTINGS = ['stake', 'ticks', 'minConf', 'maxTrades', 'takeProfit', 'stopLoss', 'martMult', 'martSteps', 'strategySelect', 'barrierSelect', 'windowSelect'];

  function restoreSettings() {
    for (const id of SETTINGS) {
      const v = store.get('set_' + id, null);
      if (v !== null) $(id).value = v;
    }
    $('martingale').checked = Boolean(store.get('set_martingale', false));
    $('martingaleRow').hidden = !$('martingale').checked;
    $('barrierField').hidden = $('strategySelect').value !== 'OVERUNDER';
  }

  function bindUI() {
    const sel = $('symbolSelect');
    for (const [code, name] of SYMBOLS) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      sel.append(o);
    }
    if (!SYMBOLS.some(([c]) => c === state.symbol)) state.symbol = '1HZ100V';
    sel.value = state.symbol;
    sel.addEventListener('change', () => { stopBot('symbol changed'); subscribeSymbol(sel.value); });

    $('accountSelect').addEventListener('change', (e) => selectAccount(e.target.value));

    for (const id of SETTINGS) {
      $(id).addEventListener('change', () => store.set('set_' + id, $(id).value));
    }
    for (const id of ['strategySelect', 'barrierSelect', 'windowSelect']) {
      $(id).addEventListener('change', () => {
        $('barrierField').hidden = $('strategySelect').value !== 'OVERUNDER';
        update();
      });
    }
    $('martingale').addEventListener('change', () => {
      store.set('set_martingale', $('martingale').checked);
      $('martingaleRow').hidden = !$('martingale').checked;
    });

    $('tradeNow').addEventListener('click', () => placeTrade(state.sig, 'manual'));
    $('autoBtn').addEventListener('click', () => (bot.running ? stopBot() : startBot()));
    $('clearLog').addEventListener('click', () => {
      state.log = state.log.filter((r) => r.status === 'open');
      state.stats = { trades: 0, wins: 0, losses: 0, pl: 0 };
      renderLog();
      renderStats();
    });

    $('createDemo').addEventListener('click', async () => {
      $('createDemo').disabled = true;
      try {
        await api('/api/accounts', { method: 'POST', body: { account_type: 'demo' } });
        await loadAccounts();
      } catch (err) {
        notice(err.message, 'error');
      } finally {
        $('createDemo').disabled = false;
      }
    });

    $('resetDemo').addEventListener('click', async () => {
      if (!state.account) return;
      try {
        await api('/api/reset-demo', { method: 'POST', body: { accountId: state.account.account_id } });
        notice('Demo balance reset.', 'ok');
      } catch (err) {
        notice(err.message, 'error');
      }
    });

    window.addEventListener('beforeunload', () => {
      if (pub) pub.close();
      if (trade) trade.close();
    });
  }

  // ---------- boot ----------
  async function init() {
    let s;
    try {
      s = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json());
    } catch {
      notice('Could not reach the server. Check your connection and reload.', 'error', true);
      return;
    }
    if (!s.loggedIn) {
      location.replace('/');
      return;
    }
    state.publicWs = s.publicWs;
    restoreSettings();
    bindUI();
    renderStats();
    renderBotState();
    startPublic();
    try {
      await loadAccounts();
    } catch (err) {
      // Still show live market data and signals even if accounts failed to load.
      $('dash').hidden = false;
      if (!err.fatal) notice(err.message, 'error', true);
    }
  }

  init();
})();
