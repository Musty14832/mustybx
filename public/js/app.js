/* Musty BX dashboard — wires the Deriv sockets, the GoalIQ scanner, the six-layer engine and the UI. */
(function () {
  'use strict';

  const E = window.DigitEngine;
  const G = window.GoalIQ;
  const $ = (id) => document.getElementById(id);

  const MIN_STAKE = 0.35;

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
    symbol: store.get('symbol', '1HZ10V'),
    analysis: null,
    sig: null,
    goal: null,
    inspect: null, // symbol shown in the GoalIQ breakdown
    risk: null,    // today's GoalIQ risk record for the current account
    inFlight: null,
    log: [],
    stats: { trades: 0, wins: 0, losses: 0, pl: 0 },
    status: { pub: 'idle', trade: 'idle' },
  };

  const bot = { running: false, baseStake: 1, stake: 1, step: 0, pl: 0, trades: 0, engine: 'goaliq' };

  let pub = null;
  let trade = null;

  // ---------- helpers ----------
  const money = (n) => (Number(n) || 0).toFixed(2);
  const round2 = (n) => Math.round(n * 100) / 100;
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const pct = (p) => (p * 100).toFixed(1) + '%';
  const signed = (x, dp = 1) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(dp);
  const localDay = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const engine = () => $('engineSelect').value;
  const sizing = () => $('sizingSelect').value;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  let noticeTimer = null;
  function notice(text, kind = 'info', sticky = false) {
    const box = $('notice');
    box.textContent = text;
    box.className = 'notice ' + kind;
    box.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) noticeTimer = setTimeout(() => { box.hidden = true; }, 7000);
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
    const box = $('notice');
    box.className = 'notice error';
    box.hidden = false;
    box.textContent = '';
    box.append('Your Deriv session has expired. ');
    const a = document.createElement('a');
    a.href = '/login';
    a.textContent = 'Log in again';
    box.append(a);
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

  // ---------- scanner ----------
  const scanner = window.createScanner({
    getPublic: () => pub,
    getTrade: () => trade,
    getCurrency: () => state.currency,
    getDuration: () => readTicks(),
    onChange: () => {},
  });
  const cur = () => scanner.get(state.symbol);

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
    state.risk = store.get('risk_' + id, null);
    syncRiskDay();
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
    scanner.startPricing();
  }

  function onTradeMessage(msg) {
    if (msg.error && msg.msg_type !== 'buy' && msg.msg_type !== 'proposal') {
      if (msg.msg_type === 'balance' || msg.msg_type === 'proposal_open_contract') notice(msg.error.message || 'Trading error', 'error');
      return;
    }
    if (msg.msg_type === 'balance' && msg.balance) {
      state.balance = Number(msg.balance.balance);
      if (msg.balance.currency) state.currency = msg.balance.currency;
      renderBalance();
      syncRiskDay();
    } else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
      onContract(msg.proposal_open_contract, msg.subscription && msg.subscription.id);
    }
  }

  // ---------- daily risk (GoalIQ) ----------
  function syncRiskDay() {
    if (!state.account || state.balance === null) return;
    const next = G.riskDay(state.risk, { now: Date.now(), today: localDay(), balance: state.balance });
    if (next !== state.risk) {
      state.risk = next;
      store.set('risk_' + state.account.account_id, next);
    }
  }

  function riskStatus() {
    if (!state.risk) return { ok: true, pending: true };
    return G.riskCheck(state.risk, Date.now(), goalSettings());
  }

  function recordRisk(profit) {
    if (!state.risk || !state.account) return;
    const r = G.riskAfterTrade(state.risk, profit, Date.now(), goalSettings());
    state.risk = r.day;
    store.set('risk_' + state.account.account_id, r.day);
    if (r.event === 'pause' && bot.running && bot.engine === 'goaliq') stopBot('daily drawdown limit hit — 24 h cooling-off started');
    else if (r.event === 'lock' && bot.running && bot.engine === 'goaliq') stopBot('daily profit target locked in');
  }

  // ---------- market data ----------
  function startPublic() {
    pub = new window.DerivSocket('Market data', async () => state.publicWs, {
      onOpen: () => scanner.subscribeAll(state.symbol),
      onMessage: onPublicMessage,
      onStatus: (s) => setStatus('pub', s),
    });
    pub.connect();
  }

  function selectSymbol(sym) {
    if (!scanner.get(sym)) sym = '1HZ10V';
    state.symbol = sym;
    store.set('symbol', sym);
    $('symbolSelect').value = sym;
    update();
  }

  function onPublicMessage(msg) {
    const sym = scanner.handle(msg);
    if (!sym || sym !== state.symbol) return;
    if (msg.error) {
      notice(`${cur().name}: ${msg.error.message || 'market data error'}`, 'error');
      return;
    }
    update();
    if (msg.msg_type === 'tick' && engine() === 'six') maybeAutoTrade();
  }

  // ---------- six-layer analysis + rendering ----------
  function strategy() { return $('strategySelect').value; }

  function update() {
    const mk = cur();
    state.analysis = E.analyze(mk.digits, { window: parseInt($('windowSelect').value, 10) || 500 });
    state.sig = E.signal(state.analysis, strategy(), $('barrierSelect').value);
    renderMarket();
    renderSignal();
  }

  function renderMarket() {
    const mk = cur();
    const q = mk.prices.length ? mk.prices[mk.prices.length - 1] : null;
    $('price').textContent = q === null ? '—' : q.toFixed(mk.decimals);
    const last = mk.digits.length ? mk.digits[mk.digits.length - 1] : null;
    const ld = $('lastDigit');
    ld.textContent = last === null ? '–' : String(last);
    ld.className = 'digit-big ' + (last === null ? '' : last % 2 ? 'odd' : 'even');
    const strip = $('digitStrip');
    strip.textContent = '';
    for (const d of mk.digits.slice(-24)) strip.append(el('span', 'chip ' + (d % 2 ? 'odd' : 'even'), d));
    $('tickCount').textContent = mk.status === 'error' ? `Unavailable: ${mk.error}` : `${mk.digits.length} ticks loaded`;
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
    const n = cur().digits.length;

    if (!a || !sig) {
      $('signalLabel').textContent = n ? `Collecting ticks (${n}/30)…` : 'Waiting for ticks…';
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
      const col = el('div', 'bar-col' + (marks.has(d) ? ' pick' : ''));
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.height = Math.max(4, (p / maxP) * 100) + '%';
      track.append(fill);
      const freq = el('div', 'bar-freq', ((a.counts[d] / a.n) * 100).toFixed(0) + '%');
      freq.title = 'Share of this digit in the window';
      col.append(el('div', 'bar-val', (p * 100).toFixed(1)), track, el('div', 'bar-lab', d), freq);
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
      for (const text of [E.LAYER_LABELS[key], String(lean), note]) tr.append(el('td', '', text));
      table.append(tr);
    }
  }

  // ---------- GoalIQ ----------
  const GOAL_INPUTS = {
    gMinScoreA: 'minScoreA', gMinScoreB: 'minScoreB', gMinEV: 'minEV', gMaxEntropy: 'maxEntropy', gMinRTP: 'minRTP',
    gAdxMinA: 'adxMinA', gBbMaxB: 'bbMaxB', gRsiLoB: 'rsiLoB', gRsiHiB: 'rsiHiB',
    gKelly: 'kellyFraction', gMaxStake: 'maxStakePct', gDD: 'dailyDDPct', gLock: 'profitLockPct',
  };

  function goalSettings() {
    const s = {};
    for (const [id, key] of Object.entries(GOAL_INPUTS)) s[key] = num(id, G.DEFAULTS[key]);
    return s;
  }

  function goalTick() {
    scanner.checkPricing();
    syncRiskDay();
    state.goal = G.rank(scanner.list(), { now: Date.now(), duration: readTicks(), settings: goalSettings() });
    renderGoal();
    if (engine() === 'goaliq') maybeGoalTrade();
  }

  /** What the GoalIQ engine would stake on this pick right now. */
  function goalStakeFor(best) {
    const st = goalSettings();
    const bal = state.balance;
    if (sizing() === 'fixed') {
      const want = bot.running && bot.engine === 'goaliq' ? bot.stake : readStake();
      const stake = bal === null ? want : G.capStake(want, bal, st);
      return { stake, note: stake < want ? `fixed, capped at ${st.maxStakePct}%` : 'fixed' };
    }
    if (bal === null) return { stake: 0, note: 'balance unknown' };
    if (!best || !best.R) return { stake: 0, note: 'needs a live payout' };
    const k = G.kellyStake(best.P, best.R, bal, st);
    if (!(k.full > 0)) return { stake: 0, note: 'no edge — Kelly says 0', kelly: k };
    return { stake: k.stake, note: `${(k.pct * 100).toFixed(2)}% of balance${k.capped ? ` (capped at ${st.maxStakePct}%)` : ''}`, kelly: k };
  }

  function statusText(row) {
    if (!row.ready) return row.status === 'error' ? 'Unavailable' : `Loading ${row.n}/60`;
    if (row.best.pass) return '✓ Ready';
    const f = row.best.failed;
    return '✗ ' + f[0].text + (f.length > 1 ? ` (+${f.length - 1})` : '');
  }

  function renderGoal() {
    const g = state.goal;
    if (!g) return;
    const live = g.rows.filter((r) => r.ready).length;
    const priced = scanner.pendingPrices();
    $('goalScanInfo').textContent = `${live}/${g.rows.length} markets live${priced ? ` · pricing ${priced}` : ''}`;

    // --- report
    const pick = g.selected;
    const show = pick || g.top;
    const best = show && show.best;
    const pickEl = $('goalPick');
    if (pick) {
      pickEl.textContent = `${best.label} · ${pick.name}`;
      $('goalPickSub').textContent = `Strategy ${best.id}: ${best.name} · Digit ${best.label} · ${readTicks()} tick${readTicks() > 1 ? 's' : ''} · MSI ${pick.msi.score.toFixed(1)}`;
    } else if (show) {
      pickEl.textContent = 'Standing aside';
      $('goalPickSub').textContent = `No market clears every gate. Best ranked: ${show.name} (${best ? best.label : '—'}, MSI ${show.msi.score.toFixed(1)}).`;
    } else {
      pickEl.textContent = 'Scanning…';
      $('goalPickSub').textContent = 'Loading tick history for each market.';
    }
    pickEl.className = 'signal-label' + (pick ? ' go' : '');

    $('goalScore').textContent = best ? best.composite.toFixed(1) : '—';
    $('goalP').textContent = best ? pct(best.P) : '—';
    $('goalIP').textContent = best && best.IP ? pct(best.IP) : '—';
    const evEl = $('goalEV');
    evEl.textContent = best && best.EV !== null ? signed(best.EV * 100) + '%' : '—';
    evEl.className = best && best.EV !== null ? (best.EV > 0 ? 'pos' : 'neg') : '';
    const sk = best ? goalStakeFor(best) : null;
    $('goalStake').textContent = sk ? (sk.stake > 0 ? money(sk.stake) : '0') : '—';
    $('goalStake').title = sk ? sk.note : '';

    const bar = $('goalBar');
    const sc = best ? best.composite : 0;
    bar.style.width = Math.min(100, sc) + '%';
    bar.className = 'meter-fill ' + (best && sc >= best.minScore ? 'hi' : sc >= 60 ? 'mid' : 'lo');

    const gates = $('goalGates');
    gates.textContent = '';
    if (best) for (const gt of best.gates) gates.append(el('span', 'gate ' + (gt.ok ? 'ok' : 'no'), (gt.ok ? '✓ ' : '✗ ') + gt.text));
    if (sk && best) gates.append(el('span', 'gate info', `stake: ${sk.note}`));

    renderRisk();

    // --- ranking
    const body = $('rankBody');
    body.textContent = '';
    g.rows.forEach((r, i) => {
      const tr = el('tr', (pick && r.symbol === pick.symbol ? 'sel ' : '') + (r.symbol === state.inspect ? 'insp ' : '') + (r.ready && r.best.pass ? 'pass' : r.ready ? '' : 'wait'));
      const b = r.best;
      const cells = [
        String(i + 1),
        r.name,
        r.msi ? r.msi.score.toFixed(1) : '—',
        b ? b.label : '—',
        b ? b.composite.toFixed(1) : '—',
        b ? pct(b.P) : '—',
        b && b.EV !== null ? signed(b.EV * 100) + '%' : '—',
        statusText(r),
      ];
      for (const c of cells) tr.append(el('td', '', c));
      tr.dataset.symbol = r.symbol;
      body.append(tr);
    });

    renderBreakdown();
  }

  function renderRisk() {
    const line = $('riskLine');
    const rk = riskStatus();
    if (rk.pending) { line.textContent = 'Daily limits start once your balance loads.'; line.className = 'small risk-line muted'; return; }
    const st = goalSettings();
    const pl = state.risk.pl;
    let text = `Today: ${signed(pl, 2)} · stop at −${money(rk.ddLimit)} (${st.dailyDDPct}%) · lock at +${money(rk.lockAt)} (${st.profitLockPct}%)`;
    if (!rk.ok) {
      text = rk.kind === 'pause'
        ? `Cooling-off until ${new Date(rk.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — daily drawdown limit hit (${signed(pl, 2)}).`
        : `Profit locked for today (${signed(pl, 2)}). GoalIQ auto-trade resumes tomorrow.`;
    }
    line.textContent = text;
    line.className = 'small risk-line ' + (rk.ok ? 'muted' : rk.kind === 'pause' ? 'neg' : 'pos');
  }

  function bdRow(parent, label, value, weight) {
    const row = el('div', 'bd-row');
    row.append(el('span', 'bd-lab', label));
    const track = el('span', 'bd-track');
    const fill = el('span', 'bd-fill');
    fill.style.width = Math.max(0, Math.min(100, value)) + '%';
    track.append(fill);
    row.append(track, el('span', 'bd-val', value.toFixed(0) + (weight ? ` ×${weight}` : '')));
    parent.append(row);
  }

  function renderBreakdown() {
    const g = state.goal;
    const r = g.rows.find((x) => x.symbol === state.inspect) || g.selected || g.top;
    const msiBox = $('bdMsi');
    const compBox = $('bdComp');
    msiBox.textContent = '';
    compBox.textContent = '';
    if (!r || !r.ready) { $('bdName').textContent = r ? `${r.name} (loading)` : '—'; $('bdInd').textContent = ''; return; }
    $('bdName').textContent = `${r.name} · MSI ${r.msi.score.toFixed(1)}`;
    const m = r.msi;
    bdRow(msiBox, 'V · volatility balance', m.V, 0.3);
    bdRow(msiBox, 'E · statistical edge', m.E, 0.25);
    bdRow(msiBox, 'T · trend integrity', m.T, 0.2);
    bdRow(msiBox, 'S · execution', m.S, 0.15);
    bdRow(msiBox, 'L · payout efficiency', m.L, 0.1);
    const b = r.best;
    $('bdStrat').textContent = `${b.label} ${b.composite.toFixed(1)} / ${b.minScore}`;
    bdRow(compBox, 'DP · density probability', b.scores.DP, 0.3);
    bdRow(compBox, 'HFR · hit frequency', b.scores.HFR, 0.25);
    bdRow(compBox, 'VMI · volatility & momentum', b.scores.VMI, 0.15);
    bdRow(compBox, 'TNE · noise & entropy', b.scores.TNE, 0.15);
    bdRow(compBox, 'PVM · payout value', b.scores.PVM, 0.15);
    const ind = r.ind;
    const f = (x, dp = 1) => (x === null || x === undefined ? '—' : Number(x).toFixed(dp));
    $('bdInd').textContent = [
      `Hit rate ${b.label}: ${pct(b.hr.h100)} (100) · ${pct(b.hr.h500)} (500) · ${pct(b.hr.h1000)} (1000)`,
      `ADX ${f(ind.adx)} · EMA 9 ${ind.ema9 > ind.ema21 ? '>' : '≤'} EMA 21 · RSI ${f(ind.rsi)} · BB width ${f(ind.bbRatio, 2)}× avg · ATR 14/50 ${f(ind.atrRatio, 2)} · MACD slope ${f(ind.macdSlopeZ, 2)}σ`,
      `Outcome entropy ${f(b.H, 3)} bits · tick σ ${f(ind.sigmaPips, 1)} pips · randomness z: digits ${f(r.zs.digits, 1)}, transitions ${f(r.zs.transitions, 1)}, autocorr ${f(r.zs.autocorr, 1)}`,
      b.R ? `Deriv payout ${b.R.toFixed(3)}× → implied ${pct(b.IP)} · payout efficiency ${pct(b.RTP)}` : 'Deriv payout not priced yet (needs the trading connection)',
    ].join('\n');
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

  function addRow(b, label, stake, source, symbol, eng) {
    const mk = scanner.get(symbol);
    const row = {
      id: b.contract_id,
      time: new Date(),
      label: `${label} · ${symbol}`,
      stake: Number(b.buy_price) || stake,
      status: 'open',
      exit: '',
      profit: null,
      source,
      engine: eng,
      decimals: mk ? mk.decimals : 2,
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
    renderBotState();
    return row;
  }

  /** Six-layer engine: direct buy on the selected market. */
  async function placeTrade(sig, source) {
    if (state.inFlight) { if (source === 'manual') notice('A contract is still running.', 'info'); return; }
    if (!sig) { notice('No signal yet — wait for more ticks.', 'info'); return; }
    if (!trade || !trade.isOpen) { notice('Trading connection is not ready yet.', 'error'); return; }
    if (realMoneyBlocked()) { stopBot(); return; }

    const stake = source === 'auto' ? bot.stake : readStake();
    if (!(stake >= MIN_STAKE)) { notice(`Minimum stake is ${MIN_STAKE}.`, 'error'); stopBot(); return; }
    if (state.balance !== null && stake > state.balance) { notice('Stake is higher than your balance.', 'error'); stopBot('Not enough balance'); return; }

    const symbol = state.symbol;
    const parameters = {
      amount: stake,
      basis: 'stake',
      contract_type: sig.contract_type,
      currency: state.currency,
      duration: readTicks(),
      duration_unit: 't',
      underlying_symbol: symbol,
    };
    if (sig.barrier !== null && sig.barrier !== undefined) parameters.barrier = String(sig.barrier);

    state.inFlight = { id: null, at: Date.now() };
    renderBotState();
    try {
      const r = await trade.send({ buy: '1', price: stake, parameters });
      addRow(r.buy, sig.label, stake, source, symbol, 'six');
    } catch (err) {
      state.inFlight = null;
      renderBotState();
      notice('Trade failed: ' + err.message, 'error');
      stopBot('Stopped after a failed trade');
    }
  }

  /** GoalIQ engine: fresh proposal on the auto-selected market, EV re-check, then buy. */
  async function placeGoalTrade(pick, source) {
    if (state.inFlight) { if (source === 'manual') notice('A contract is still running.', 'info'); return; }
    if (!trade || !trade.isOpen) { notice('Trading connection is not ready yet.', 'error'); return; }
    if (realMoneyBlocked()) { stopBot(); return; }
    const rk = riskStatus();
    if (!rk.ok) { notice('GoalIQ: ' + rk.reason, 'error'); stopBot(rk.reason); return; }
    if (rk.pending) { if (source === 'manual') notice('Waiting for your balance before trading.', 'info'); return; }

    const best = pick.best;
    const st = goalSettings();
    const sk = goalStakeFor(best);
    if (!(sk.stake >= MIN_STAKE)) {
      const why = sk.stake > 0 ? `stake ${money(sk.stake)} is below Deriv's minimum ${MIN_STAKE}` : `stake is 0 (${sk.note})`;
      if (source === 'manual') notice('GoalIQ: ' + why, 'info');
      else $('autoStatus').textContent = `Waiting: ${pick.name} ${best.label} passes, but ${why}. Session P/L ${money(bot.pl)} · ${bot.trades} trades`;
      return;
    }
    if (state.balance !== null && sk.stake > state.balance) { notice('Stake is higher than your balance.', 'error'); stopBot('Not enough balance'); return; }

    state.inFlight = { id: null, at: Date.now() };
    renderBotState();
    const req = {
      proposal: 1,
      amount: sk.stake,
      basis: 'stake',
      contract_type: best.contract_type,
      barrier: String(best.barrier),
      currency: state.currency,
      duration: readTicks(),
      duration_unit: 't',
      underlying_symbol: pick.symbol,
    };
    let prop;
    try {
      prop = (await trade.send(req)).proposal;
    } catch (err) {
      state.inFlight = null;
      renderBotState();
      notice(`Deriv refused the price for ${pick.name} ${best.label}: ${err.message}`, 'error');
      if (source === 'auto') stopBot('Deriv refused a price');
      return;
    }
    const ask = Number(prop.ask_price);
    const R = Number(prop.payout) / ask;
    scanner.notePayout(pick.symbol, best.id, R);
    const ev = best.P * R - 1;
    if (!(ev * 100 >= st.minEV)) {
      state.inFlight = null;
      renderBotState();
      const why = `payout ${R.toFixed(3)}× gives EV ${signed(ev * 100)}% (needs +${st.minEV}%)`;
      if (source === 'manual') notice(`GoalIQ skipped ${pick.name}: ${why}`, 'info');
      else $('autoStatus').textContent = `Skipped ${pick.name} ${best.label}: ${why}`;
      return;
    }
    if (source === 'auto') $('autoStatus').textContent = `Buying ${best.label} on ${pick.name} for ${money(ask)} (EV ${signed(ev * 100)}%)…`;
    try {
      const r = await trade.send({ buy: prop.id, price: ask });
      addRow(r.buy, `GoalIQ ${best.label}`, ask, source, pick.symbol, 'goaliq');
    } catch (err) {
      state.inFlight = null;
      renderBotState();
      notice('Trade failed: ' + err.message, 'error');
      stopBot('Stopped after a failed trade');
    }
  }

  function exitDigitOf(c, decimals) {
    const disp = c.exit_tick_display_value || c.exit_spot_display_value || c.sell_spot_display_value;
    if (disp !== undefined && disp !== null && String(disp).length) {
      const s = String(disp);
      return { text: s, digit: s.charCodeAt(s.length - 1) - 48 };
    }
    const v = c.exit_tick !== undefined ? c.exit_tick : c.exit_spot !== undefined ? c.exit_spot : c.sell_spot;
    if (v === undefined || v === null) return { text: '', digit: null };
    return { text: Number(v).toFixed(decimals), digit: E.lastDigit(v, decimals) };
  }

  function onContract(c, subId) {
    const id = Number(c.contract_id);
    const row = state.log.find((r) => Number(r.id) === id);
    const finished = Number(c.is_sold) === 1 || ['won', 'lost', 'sold'].includes(String(c.status));
    if (!finished) return;
    if (subId) trade.post({ forget: subId });
    if (!row || row.status !== 'open') return;

    const profit = Number(c.profit);
    const ex = exitDigitOf(c, row.decimals);
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
    recordRisk(row.profit);
    renderBotState();
    renderRisk();
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
      const tr = el('tr', 'empty');
      const td = el('td', '', 'No trades yet');
      td.colSpan = 5;
      tr.append(td);
      body.append(tr);
      return;
    }
    for (const r of state.log.slice(0, 50)) {
      const tr = el('tr', r.status);
      const cells = [
        r.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        r.label + (r.source === 'auto' ? ' · auto' : ''),
        money(r.stake),
        r.exit,
        r.status === 'open' ? '…' : r.status === 'unknown' ? '?' : (r.profit > 0 ? '+' : '') + money(r.profit),
      ];
      for (const c of cells) tr.append(el('td', '', c));
      body.append(tr);
    }
  }

  // ---------- auto-trader ----------
  function renderBotState() {
    const badge = $('botState');
    const btn = $('autoBtn');
    if (bot.running) {
      badge.textContent = state.inFlight ? 'Trading…' : bot.engine === 'goaliq' ? 'GoalIQ on' : 'Auto on';
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
    const eng = engine();
    const stake = readStake();
    if (eng === 'goaliq') {
      const rk = riskStatus();
      if (!rk.ok) { notice('GoalIQ: ' + rk.reason, 'error'); return; }
      if (sizing() === 'fixed' && !(stake >= MIN_STAKE)) { notice(`Minimum stake is ${MIN_STAKE}.`, 'error'); return; }
    } else if (!(stake >= MIN_STAKE)) { notice(`Minimum stake is ${MIN_STAKE}.`, 'error'); return; }
    bot.running = true;
    bot.engine = eng;
    bot.baseStake = stake;
    bot.stake = stake;
    bot.step = 0;
    bot.pl = 0;
    bot.trades = 0;
    $('autoStatus').textContent = eng === 'goaliq'
      ? 'GoalIQ auto-trade on — scanning every market for one that clears all gates.'
      : 'Auto-trade on — waiting for a strong enough signal.';
    renderBotState();
    if (eng === 'goaliq') maybeGoalTrade(); else maybeAutoTrade();
  }

  function stopBot(reason) {
    if (!bot.running) { renderBotState(); return; }
    bot.running = false;
    $('autoStatus').textContent = reason ? `Stopped: ${reason}. Session P/L ${money(bot.pl)} over ${bot.trades} trades.` : `Stopped. Session P/L ${money(bot.pl)} over ${bot.trades} trades.`;
    if (reason) notice(`Auto-trade stopped: ${reason}`, 'info');
    renderBotState();
  }

  function maybeAutoTrade() {
    if (!bot.running || bot.engine !== 'six' || state.inFlight || !state.sig) return;
    const minConf = num('minConf', 50);
    if (state.sig.confidence < minConf) {
      $('autoStatus').textContent = `Waiting: confidence ${state.sig.confidence} < ${minConf}. Session P/L ${money(bot.pl)} · ${bot.trades} trades · next stake ${money(bot.stake)}`;
      return;
    }
    $('autoStatus').textContent = `Placing ${state.sig.label} for ${money(bot.stake)}…`;
    placeTrade(state.sig, 'auto');
  }

  function maybeGoalTrade() {
    if (!bot.running || bot.engine !== 'goaliq' || state.inFlight || !state.goal) return;
    const rk = riskStatus();
    if (!rk.ok) { stopBot(rk.reason); return; }
    const pick = state.goal.selected;
    if (!pick) {
      const t = state.goal.top;
      const why = t && t.best ? `${t.name} ${t.best.label} — ${t.best.failed[0].text}` : 'markets still loading';
      $('autoStatus').textContent = `Standing aside: no market clears every gate (best: ${why}). Session P/L ${money(bot.pl)} · ${bot.trades} trades`;
      return;
    }
    placeGoalTrade(pick, 'auto');
  }

  function afterBotTrade(profit) {
    bot.trades++;
    bot.pl = round2(bot.pl + profit);

    const useMart = bot.engine === 'six' && $('martingale').checked;
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
    if (bot.engine === 'six' && sl > 0 && bot.pl - bot.stake < -sl) return stopBot(`next stake ${money(bot.stake)} would break the stop loss`);
    if (bot.trades >= maxTrades) return stopBot(`max trades reached (${bot.trades})`);
    $('autoStatus').textContent = bot.engine === 'goaliq'
      ? `Session P/L ${money(bot.pl)} · ${bot.trades} trades · scanning for the next setup`
      : `Session P/L ${money(bot.pl)} · ${bot.trades} trades · next stake ${money(bot.stake)}`;
  }

  // ---------- settings ----------
  const SETTINGS = ['stake', 'ticks', 'minConf', 'maxTrades', 'takeProfit', 'stopLoss', 'martMult', 'martSteps', 'strategySelect', 'barrierSelect', 'windowSelect', 'engineSelect', 'sizingSelect', ...Object.keys(GOAL_INPUTS)];

  function applyEngineUI() {
    const goal = engine() === 'goaliq';
    $('sizingField').hidden = !goal;
    $('stakeField').hidden = goal && sizing() === 'kelly';
    $('minConfField').hidden = goal;
    $('martingaleWrap').hidden = goal;
    $('martingaleRow').hidden = goal || !$('martingale').checked;
    $('tradeNow').textContent = goal ? 'Trade GoalIQ pick now' : 'Trade signal now';
  }

  function restoreSettings() {
    for (const id of SETTINGS) {
      const v = store.get('set_' + id, null);
      if (v !== null) $(id).value = v;
    }
    if (!$('engineSelect').value) $('engineSelect').value = 'goaliq';
    if (!$('sizingSelect').value) $('sizingSelect').value = 'kelly';
    $('martingale').checked = Boolean(store.get('set_martingale', false));
    $('barrierField').hidden = $('strategySelect').value !== 'OVERUNDER';
    applyEngineUI();
  }

  function bindUI() {
    const sel = $('symbolSelect');
    const groups = {};
    for (const c of G.CATALOG) {
      if (!groups[c.group]) { groups[c.group] = document.createElement('optgroup'); groups[c.group].label = c.group; sel.append(groups[c.group]); }
      const o = document.createElement('option');
      o.value = c.symbol;
      o.textContent = c.name;
      groups[c.group].append(o);
    }
    if (!scanner.get(state.symbol)) state.symbol = '1HZ10V';
    sel.value = state.symbol;
    sel.addEventListener('change', () => { if (bot.engine === 'six') stopBot('symbol changed'); selectSymbol(sel.value); });

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
    $('engineSelect').addEventListener('change', () => { stopBot('engine changed'); applyEngineUI(); });
    $('sizingSelect').addEventListener('change', applyEngineUI);
    $('martingale').addEventListener('change', () => {
      store.set('set_martingale', $('martingale').checked);
      applyEngineUI();
    });
    $('goalReset').addEventListener('click', () => {
      for (const [id, key] of Object.entries(GOAL_INPUTS)) { $(id).value = G.DEFAULTS[key]; store.set('set_' + id, $(id).value); }
      goalTick();
    });
    $('rankBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-symbol]');
      if (!tr) return;
      state.inspect = tr.dataset.symbol;
      $('goalBreakdown').open = true;
      renderGoal();
    });

    $('tradeNow').addEventListener('click', () => {
      if (engine() === 'six') return placeTrade(state.sig, 'manual');
      const g = state.goal;
      if (!g || !g.selected) {
        const t = g && g.top;
        notice(t && t.best ? `No market clears every GoalIQ gate right now. Best: ${t.name} ${t.best.label} — ${t.best.failed.map((x) => x.text).join(', ')}.` : 'GoalIQ is still loading markets.', 'info');
        return undefined;
      }
      return placeGoalTrade(g.selected, 'manual');
    });
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
    update();
    startPublic();
    setInterval(goalTick, 1000);
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
