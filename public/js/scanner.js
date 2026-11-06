/*
 * Multi-market feed for GoalIQ.
 *  - Streams every catalog symbol on the public socket (paced so Deriv
 *    doesn't drop the connection) and keeps ~1500 ticks per market.
 *  - Prices the Over 2 / Under 7 contracts on each market with background
 *    proposals on the trading socket, so EV uses Deriv's real payout.
 */
(function (root) {
  'use strict';

  const G = root.GoalIQ;
  const E = root.DigitEngine;
  const MAX_TICKS = 1500;
  const SUB_GAP_MS = 250;
  const PRICE_GAP_MS = 450;
  const REPRICE_MS = 5 * 60 * 1000;

  const decimalsOf = (pip) => {
    const v = Number(pip);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v === 0) return 0;
    return v < 1 ? Math.max(0, Math.round(-Math.log10(v))) : Math.round(v);
  };

  root.createScanner = function createScanner({ getPublic, getTrade, getCurrency, getDuration, onChange }) {
    const markets = new Map();
    for (const c of G.CATALOG) {
      markets.set(c.symbol, Object.assign({}, c, {
        prices: [],
        digits: [],
        decimals: 2,
        lastAt: 0,
        interval: /^1HZ|^stp/.test(c.symbol) ? 1000 : 2000,
        status: 'idle',
        error: '',
        payouts: {},
      }));
    }

    let subTimers = [];
    let priceTimer = null;
    let repriceTimer = null;
    let queue = [];
    let pricedFor = null;

    function subscribeAll(first) {
      subTimers.forEach(clearTimeout);
      subTimers = [];
      const order = [first, ...[...markets.keys()].filter((s) => s !== first)].filter((s) => markets.has(s));
      order.forEach((sym, i) => {
        subTimers.push(setTimeout(() => {
          const pub = getPublic();
          if (!pub || !pub.isOpen) return;
          const mk = markets.get(sym);
          // Fresh start: history + the ticks that beat it here rebuild the buffer.
          mk.prices = [];
          mk.digits = [];
          mk.status = 'loading';
          pub.post({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' });
          pub.post({ ticks: sym, subscribe: 1 });
        }, i * SUB_GAP_MS));
      });
      onChange();
    }

    function symbolOf(msg) {
      const er = msg.echo_req || {};
      return (msg.tick && (msg.tick.symbol || msg.tick.underlying_symbol)) || er.ticks_history || er.ticks || null;
    }

    function pushPrice(mk, p) {
      mk.prices.push(p);
      mk.digits.push(E.lastDigit(p, mk.decimals));
      if (mk.prices.length > MAX_TICKS) {
        mk.prices.splice(0, mk.prices.length - MAX_TICKS);
        mk.digits.splice(0, mk.digits.length - MAX_TICKS);
      }
    }

    /** Feed one public-socket message in. Returns the symbol it updated, or null. */
    function handle(msg) {
      const sym = symbolOf(msg);
      const mk = sym && markets.get(sym);
      if (!mk) return null;
      if (msg.error) {
        if (['history', 'tick', 'ticks_history', 'ticks'].includes(msg.msg_type)) {
          mk.status = 'error';
          mk.error = msg.error.message || msg.error.code || 'unavailable';
          onChange();
          return sym;
        }
        return null;
      }
      if (msg.msg_type === 'history' && msg.history) {
        const dec = decimalsOf(msg.pip_size);
        if (dec !== null) mk.decimals = dec;
        const live = mk.prices.slice(); // ticks that arrived before this reply
        const hist = (msg.history.prices || []).map(Number).filter(Number.isFinite);
        mk.prices = [];
        mk.digits = [];
        for (const p of hist.concat(live)) pushPrice(mk, p);
        mk.status = 'live';
        mk.error = '';
        mk.lastAt = Date.now();
        onChange();
        return sym;
      }
      if (msg.msg_type === 'tick' && msg.tick) {
        const dec = decimalsOf(msg.tick.pip_size);
        if (dec !== null) mk.decimals = dec;
        const now = Date.now();
        if (mk.lastAt && mk.status === 'live') {
          const gap = now - mk.lastAt;
          if (gap > 100 && gap < 10000) mk.interval = mk.interval * 0.9 + gap * 0.1;
        }
        mk.lastAt = now;
        pushPrice(mk, Number(msg.tick.quote));
        if (mk.status !== 'live') { mk.status = mk.prices.length >= 60 ? 'live' : 'loading'; }
        return sym;
      }
      return null;
    }

    // ---- payout calibration on the trading socket ----
    function buildQueue() {
      queue = [];
      for (const mk of markets.values()) {
        for (const id of mk.strategies) {
          const p = mk.payouts[id];
          if (p && p.error && p.permanent) continue;
          queue.push({ sym: mk.symbol, id });
        }
      }
    }

    let pricing = false;
    async function priceNext() {
      const trade = getTrade();
      if (pricing || !trade || !trade.isOpen || !queue.length) return;
      pricing = true;
      try { await priceJob(trade, queue.shift()); } finally { pricing = false; }
    }

    async function priceJob(trade, job) {
      const mk = markets.get(job.sym);
      const S = G.STRATEGIES[job.id];
      const req = {
        proposal: 1,
        amount: 10,
        basis: 'stake',
        contract_type: S.contract_type,
        barrier: String(S.barrier),
        currency: getCurrency(),
        duration: getDuration(),
        duration_unit: 't',
        underlying_symbol: mk.symbol,
      };
      try {
        const r = await trade.send(req, { timeout: 12000 });
        const p = r.proposal || {};
        const R = Number(p.payout) / Number(p.ask_price);
        mk.payouts[job.id] = R > 1 ? { R, at: Date.now() } : { error: 'payout unreadable', at: Date.now() };
      } catch (err) {
        const msg = String(err.message || '');
        const permanent = /offer|not available|invalid|unknown|not supported/i.test(msg + ' ' + (err.code || ''));
        if (permanent) mk.payouts[job.id] = { error: 'Over/Under not offered here', permanent: true, at: Date.now() };
        else if (!mk.payouts[job.id] || !mk.payouts[job.id].R) mk.payouts[job.id] = { error: 'pricing failed — retrying', at: Date.now() };
        if (!permanent) queue.push(job);
      }
      onChange();
    }

    function startPricing() {
      clearInterval(priceTimer);
      clearInterval(repriceTimer);
      pricedFor = `${getCurrency()}|${getDuration()}`;
      buildQueue();
      priceTimer = setInterval(priceNext, PRICE_GAP_MS);
      repriceTimer = setInterval(() => { if (!queue.length) buildQueue(); }, REPRICE_MS);
    }

    /** Re-price if the duration or currency changed (payouts depend on them). */
    function checkPricing() {
      if (pricedFor !== `${getCurrency()}|${getDuration()}`) {
        for (const mk of markets.values()) for (const id of Object.keys(mk.payouts)) if (!mk.payouts[id].permanent) delete mk.payouts[id];
        startPricing();
      }
    }

    /** Store a payout seen on a real pre-trade proposal. */
    function notePayout(sym, id, R) {
      const mk = markets.get(sym);
      if (mk && R > 1) mk.payouts[id] = { R, at: Date.now() };
    }

    return {
      markets,
      get: (sym) => markets.get(sym),
      list: () => [...markets.values()],
      handle,
      subscribeAll,
      startPricing,
      checkPricing,
      notePayout,
      pendingPrices: () => queue.length,
      stop() { subTimers.forEach(clearTimeout); clearInterval(priceTimer); clearInterval(repriceTimer); },
    };
  };
})(window);
