/*
 * GoalIQ-Ultimate engine for Musty BX.
 *
 * Scans Deriv synthetic indices, ranks them with the Market Suitability Index,
 * scores each market's Over 2 / Under 7 digit contract with a five-indicator
 * composite, and sizes stakes with fractional Kelly under hard risk limits.
 *
 *   MSI    = 0.30 V + 0.25 E + 0.20 T + 0.15 S + 0.10 L          (0–100)
 *   S_comp = 0.30 DP + 0.25 HFR + 0.15 VMI + 0.15 TNE + 0.15 PVM  (0–100)
 *
 *   Strategy A  Over 2  (digits 3–9 win)  Vol 50/75, Jump 50/75/100
 *               ADX > 28, EMA 9 > EMA 21, S_comp ≥ 78
 *   Strategy B  Under 7 (digits 0–6 win)  Vol 10/25, Step, Jump 10/25
 *               BB width ratio < 1.2, RSI 40–60, S_comp ≥ 88
 *   Every trade also needs EV ≥ +5% against Deriv's live payout, outcome
 *   entropy ≤ 0.85 and payout efficiency ≥ 92%.
 *
 * Both contracts win 70% of the time by pure chance, and Deriv prices them
 * below fair odds. On markets driven by a fair random number generator the
 * gates above are rarely met, so the engine mostly stands aside; that is the
 * spec working as written, not a fault.
 *
 * Indicators (ADX, ATR, RSI, MACD, EMA, Bollinger) run on 5-tick bars.
 * Works in the browser (window.GoalIQ) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const std = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
  };
  const mod10 = (x) => ((x % 10) + 10) % 10;
  const round2 = (x) => Math.round(x * 100) / 100;
  const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;

  // ------------------------------------------------------------------ catalog
  const STRATEGIES = Object.freeze({
    A: Object.freeze({ id: 'A', name: 'Over 2 · trend barrier breakout', short: 'Over 2', contract_type: 'DIGITOVER', barrier: 2, hits: [3, 4, 5, 6, 7, 8, 9], base: 0.7 }),
    B: Object.freeze({ id: 'B', name: 'Under 7 · fortress range', short: 'Under 7', contract_type: 'DIGITUNDER', barrier: 7, hits: [0, 1, 2, 3, 4, 5, 6], base: 0.7 }),
  });

  // prior = Market Hierarchy Rank from the spec, as a 0–100 preference.
  const CATALOG = Object.freeze([
    { symbol: '1HZ10V', name: 'Volatility 10 (1s)', group: 'Volatility', strategies: ['B'], prior: 100 },
    { symbol: 'R_10', name: 'Volatility 10', group: 'Volatility', strategies: ['B'], prior: 100 },
    { symbol: '1HZ25V', name: 'Volatility 25 (1s)', group: 'Volatility', strategies: ['B'], prior: 100 },
    { symbol: 'R_25', name: 'Volatility 25', group: 'Volatility', strategies: ['B'], prior: 100 },
    { symbol: '1HZ50V', name: 'Volatility 50 (1s)', group: 'Volatility', strategies: ['A'], prior: 70 },
    { symbol: 'R_50', name: 'Volatility 50', group: 'Volatility', strategies: ['A'], prior: 70 },
    { symbol: '1HZ75V', name: 'Volatility 75 (1s)', group: 'Volatility', strategies: ['A'], prior: 70 },
    { symbol: 'R_75', name: 'Volatility 75', group: 'Volatility', strategies: ['A'], prior: 70 },
    { symbol: '1HZ100V', name: 'Volatility 100 (1s)', group: 'Volatility', strategies: [], prior: 40 },
    { symbol: 'R_100', name: 'Volatility 100', group: 'Volatility', strategies: [], prior: 40 },
    { symbol: 'stpRNG', name: 'Step Index', group: 'Step & Jump', strategies: ['B'], prior: 85 },
    { symbol: 'JD10', name: 'Jump 10', group: 'Step & Jump', strategies: ['B'], prior: 85 },
    { symbol: 'JD25', name: 'Jump 25', group: 'Step & Jump', strategies: ['B'], prior: 85 },
    { symbol: 'JD50', name: 'Jump 50', group: 'Step & Jump', strategies: ['A'], prior: 85 },
    { symbol: 'JD75', name: 'Jump 75', group: 'Step & Jump', strategies: ['A'], prior: 85 },
    { symbol: 'JD100', name: 'Jump 100', group: 'Step & Jump', strategies: ['A'], prior: 85 },
  ]);

  const DEFAULTS = Object.freeze({
    minScoreA: 78,      // S_comp needed for Strategy A
    minScoreB: 88,      // S_comp needed for Strategy B
    minEV: 5,           // % expected value against the live payout
    maxEntropy: 0.85,   // bits, outcome-stream entropy ceiling
    minRTP: 92,         // % payout efficiency (payout × fair win chance)
    adxMinA: 28,
    bbMaxB: 1.2,        // Bollinger width ÷ its average
    rsiLoB: 40,
    rsiHiB: 60,
    kellyFraction: 0.25,
    maxStakePct: 3,     // % of balance per trade
    dailyDDPct: 10,     // % of start-of-day balance → 24 h pause
    profitLockPct: 15,  // % of start-of-day balance → done for the day
  });

  const BAR_TICKS = 5;
  const WINDOW = 1000;
  const MIN_TICKS = 300;
  const DIRICHLET_ALPHA = 5;

  // --------------------------------------------------------------- indicators
  function emaSeries(v, n) {
    const k = 2 / (n + 1);
    const out = new Array(v.length);
    let e = v[0];
    for (let i = 0; i < v.length; i++) {
      e = i === 0 ? v[0] : v[i] * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  function rsi(closes, n = 14) {
    if (closes.length < n + 1) return null;
    let g = 0;
    let l = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    g /= n;
    l /= n;
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  }

  /** Group ticks into OHLC bars of `size` ticks, aligned to the newest tick. */
  function toBars(prices, size = BAR_TICKS) {
    const bars = [];
    const start = prices.length % size;
    for (let i = start; i + size <= prices.length; i += size) {
      let h = -Infinity;
      let l = Infinity;
      for (let j = i; j < i + size; j++) {
        if (prices[j] > h) h = prices[j];
        if (prices[j] < l) l = prices[j];
      }
      bars.push({ o: prices[i], h, l, c: prices[i + size - 1] });
    }
    return bars;
  }

  function trueRanges(bars) {
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      const pc = bars[i - 1].c;
      tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
    }
    return tr;
  }

  function atr(bars, n = 14) {
    const tr = trueRanges(bars);
    if (tr.length < n) return null;
    let a = mean(tr.slice(0, n));
    for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
    return a;
  }

  function adx(bars, n = 14) {
    if (bars.length < 2 * n + 1) return null;
    const tr = [];
    const pdm = [];
    const mdm = [];
    for (let i = 1; i < bars.length; i++) {
      const up = bars[i].h - bars[i - 1].h;
      const dn = bars[i - 1].l - bars[i].l;
      pdm.push(up > dn && up > 0 ? up : 0);
      mdm.push(dn > up && dn > 0 ? dn : 0);
      const pc = bars[i - 1].c;
      tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
    }
    let sTr = 0; let sP = 0; let sM = 0;
    for (let i = 0; i < n; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
    const dx = [];
    let pdi = 0; let mdi = 0;
    for (let i = n; i <= tr.length; i++) {
      if (i > n) {
        sTr = sTr - sTr / n + tr[i - 1];
        sP = sP - sP / n + pdm[i - 1];
        sM = sM - sM / n + mdm[i - 1];
      }
      pdi = sTr > 0 ? (100 * sP) / sTr : 0;
      mdi = sTr > 0 ? (100 * sM) / sTr : 0;
      const s = pdi + mdi;
      dx.push(s > 0 ? (100 * Math.abs(pdi - mdi)) / s : 0);
    }
    if (dx.length < n) return null;
    let a = mean(dx.slice(0, n));
    for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]) / n;
    return { adx: a, pdi, mdi };
  }

  function macdHist(closes, f = 12, s = 26, sig = 9) {
    if (closes.length < s + sig) return null;
    const ef = emaSeries(closes, f);
    const es = emaSeries(closes, s);
    const line = ef.map((v, i) => v - es[i]);
    const signal = emaSeries(line.slice(s - 1), sig);
    return line.slice(s - 1).map((v, i) => v - signal[i]);
  }

  function bollingerWidths(closes, n = 20, k = 2) {
    const out = [];
    for (let i = n - 1; i < closes.length; i++) out.push(2 * k * std(closes.slice(i - n + 1, i + 1)));
    return out;
  }

  // -------------------------------------------------------------- statistics
  /** Chi-square → approximate z-score (Wilson–Hilferty). */
  function chiToZ(chi2, k) {
    if (!(k > 0)) return 0;
    const a = 2 / (9 * k);
    return (Math.cbrt(Math.max(0, chi2) / k) - (1 - a)) / Math.sqrt(a);
  }

  function digitUniformityZ(digits) {
    const n = digits.length;
    if (n < 50) return 0;
    const c = Array(10).fill(0);
    for (const d of digits) c[d]++;
    const e = n / 10;
    return chiToZ(c.reduce((s, x) => s + ((x - e) * (x - e)) / e, 0), 9);
  }

  /** Does the next digit depend on the current one? 10×10 independence test. */
  function digitTransitionZ(digits) {
    const n = digits.length - 1;
    if (n < 100) return 0;
    const t = Array.from({ length: 10 }, () => Array(10).fill(0));
    for (let i = 1; i < digits.length; i++) t[digits[i - 1]][digits[i]]++;
    const rows = t.map((r) => r.reduce((a, b) => a + b, 0));
    const cols = Array.from({ length: 10 }, (_, j) => t.reduce((a, r) => a + r[j], 0));
    let chi = 0;
    let usedR = 0;
    let usedC = 0;
    for (let i = 0; i < 10; i++) if (rows[i]) usedR++;
    for (let j = 0; j < 10; j++) if (cols[j]) usedC++;
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const e = (rows[i] * cols[j]) / n;
        if (e > 0) chi += ((t[i][j] - e) * (t[i][j] - e)) / e;
      }
    }
    return chiToZ(chi, (usedR - 1) * (usedC - 1));
  }

  function lag1AutocorrZ(x) {
    const n = x.length;
    if (n < 50) return 0;
    const m = mean(x);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      den += (x[i] - m) * (x[i] - m);
      if (i > 0) num += (x[i] - m) * (x[i - 1] - m);
    }
    return den > 0 ? (num / den) * Math.sqrt(n) : 0;
  }

  const h2 = (p) => (p <= 0 || p >= 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p));

  /**
   * Tick-noise entropy: how uncertain the win/loss is once you know the digit
   * the trade starts from, in bits (0 = fully predictable, 1 = coin flip).
   * states[i] is the digit before outcome bits[i]. Miller–Madow corrected so
   * short windows don't look more orderly than they are.
   */
  function outcomeEntropy(states, bits) {
    const n = bits.length;
    if (n < 30) return 1;
    const c = Array.from({ length: 10 }, () => [0, 0]);
    for (let i = 0; i < n; i++) c[states[i]][bits[i]]++;
    let H = 0;
    for (const [a, b] of c) {
      const row = a + b;
      if (!row) continue;
      const corr = a && b ? 1 / (2 * row * Math.LN2) : 0;
      H += (row / n) * Math.min(1, h2(b / row) + corr);
    }
    return H;
  }

  /**
   * Density Probability engine: chance the digit `h` ticks ahead lands in the
   * win set, from the smoothed empirical density of h-tick price increments
   * (in pips, wrapped to the last digit) applied to the current digit.
   * Averages horizons because the settling tick can be one later than planned.
   */
  function densityProbability(ints, hitMask, horizons) {
    const n = ints.length;
    const d = mod10(ints[n - 1]);
    let total = 0;
    for (const h of horizons) {
      const counts = Array(10).fill(DIRICHLET_ALPHA);
      for (let t = Math.max(0, n - 1 - WINDOW - h); t + h < n; t++) counts[mod10(ints[t + h] - ints[t])]++;
      const sum = counts.reduce((a, b) => a + b, 0);
      let p = 0;
      for (let k = 0; k < 10; k++) if (hitMask[mod10(d + k)]) p += counts[k] / sum;
      total += p;
    }
    return total / horizons.length;
  }

  // --------------------------------------------------------------- evaluation
  const scoreAround = (x, center, span) => clamp(50 + ((x - center) / span) * 50, 0, 100);

  function bandScore(x, lo, hi, falloff = 15) {
    if (x === null || x === undefined) return 50;
    if (x >= lo && x <= hi) return 100;
    const dist = x < lo ? lo - x : x - hi;
    return clamp(100 - (100 * dist) / falloff, 0, 100);
  }

  /** Shared per-market measurements (strategy independent). */
  function measure(mk) {
    const prices = mk.prices.slice(-(WINDOW + 12));
    const scale = Math.pow(10, mk.decimals | 0);
    const ints = prices.map((p) => Math.round(p * scale));
    const digits = ints.map(mod10).slice(-WINDOW);
    const rets = [];
    for (let i = Math.max(1, ints.length - WINDOW); i < ints.length; i++) rets.push(ints[i] - ints[i - 1]);

    const bars = toBars(prices.slice(-WINDOW));
    const closes = bars.map((b) => b.c);
    const ef = closes.length ? emaSeries(closes, 9) : [];
    const es = closes.length ? emaSeries(closes, 21) : [];
    const last = closes.length - 1;
    const hist = macdHist(closes);
    const widths = bollingerWidths(closes);
    const atr14 = atr(bars, 14);
    const atr50 = atr(bars, 50);
    const histStd = hist ? std(hist) : 0;

    const ind = {
      bars: bars.length,
      adx: null, pdi: null, mdi: null,
      ema9: last >= 0 ? ef[last] : null,
      ema21: last >= 0 ? es[last] : null,
      emaSlope9: last >= 3 ? ef[last] - ef[last - 3] : 0,
      emaSlope21: last >= 3 ? es[last] - es[last - 3] : 0,
      rsi: rsi(closes, 14),
      atrRatio: atr14 && atr50 ? atr14 / atr50 : null,
      macdSlopeZ: hist && hist.length > 3 && histStd > 0 ? (hist[hist.length - 1] - hist[hist.length - 4]) / histStd : 0,
      bbRatio: widths.length > 20 && mean(widths) > 0 ? widths[widths.length - 1] / mean(widths) : null,
      sigmaPips: std(rets),
    };
    const ax = adx(bars, 14);
    if (ax) Object.assign(ind, { adx: ax.adx, pdi: ax.pdi, mdi: ax.mdi });

    // V — volatility balance: steady tick volatility, no micro-spikes.
    const blocks = [];
    for (let i = 0; i + 50 <= rets.length; i += 50) blocks.push(std(rets.slice(i, i + 50)));
    const cv = blocks.length > 2 && mean(blocks) > 0 ? std(blocks) / mean(blocks) : 1;
    const sd = std(rets);
    const mr = mean(rets);
    const spikes = sd > 0 ? rets.filter((r) => Math.abs(r - mr) > 4 * sd).length / rets.length : 0;
    const vMeasured = 100 * clamp(1 - cv / 0.5, 0, 1) * (1 - 0.6 * clamp(spikes / 0.004, 0, 1));
    const V = 0.7 * vMeasured + 0.3 * (mk.prior || 50);

    // E — statistical edge: largest deviation from a fair random walk.
    const zs = { digits: digitUniformityZ(digits), transitions: digitTransitionZ(digits), autocorr: Math.abs(lag1AutocorrZ(rets)) };
    const zmax = Math.max(zs.digits, zs.transitions, zs.autocorr);
    const E = 100 * clamp((zmax - 1) / 3, 0, 1);

    // T — trend integrity: ADX strength plus EMA 9/21 alignment.
    const aligned = ind.ema9 !== null && ((ind.ema9 > ind.ema21 && ind.emaSlope9 > 0 && ind.emaSlope21 > 0) || (ind.ema9 < ind.ema21 && ind.emaSlope9 < 0 && ind.emaSlope21 < 0));
    const T = 0.7 * 100 * clamp((ind.adx || 0) / 50, 0, 1) + 0.3 * (aligned ? 100 : 30);

    return { ints, digits, rets, ind, V, E, T, zs, cv, spikes, aligned };
  }

  function evaluateStrategy(id, mk, m, ctx) {
    const S = STRATEGIES[id];
    const st = ctx.settings;
    const hitMask = Array(10).fill(false);
    for (const d of S.hits) hitMask[d] = true;
    const dg = m.digits;
    const rate = (k) => {
      const w = dg.slice(-k);
      return w.length ? w.filter((d) => hitMask[d]).length / w.length : S.base;
    };
    const hr = { h100: rate(100), h500: rate(500), h1000: rate(1000) };
    hr.weighted = 0.2 * hr.h100 + 0.3 * hr.h500 + 0.5 * hr.h1000;

    const dur = clamp(Math.round(ctx.duration || 1), 1, 10);
    const P = m.ints.length > 30 ? densityProbability(m.ints, hitMask, [dur, dur + 1]) : S.base;
    const states = [];
    const bits = [];
    for (let i = Math.max(dur, dg.length - 500); i < dg.length; i++) { states.push(dg[i - dur]); bits.push(hitMask[dg[i]] ? 1 : 0); }
    const H = outcomeEntropy(states, bits);
    const ind = m.ind;

    const vmiAtr = ind.atrRatio ? 100 * clamp(1 - Math.abs(Math.log(ind.atrRatio)) / Math.log(1.5), 0, 1) : 50;
    const vmiRsi = id === 'A' ? bandScore(ind.rsi, 50, 70) : bandScore(ind.rsi, st.rsiLoB, st.rsiHiB);
    const vmiMacd = id === 'A' ? 50 + 50 * Math.tanh(ind.macdSlopeZ) : 100 * (1 - Math.min(1, Math.abs(ind.macdSlopeZ)));

    const pay = (mk.payouts && mk.payouts[id]) || null;
    const R = pay && pay.R > 1 ? pay.R : null;
    const EV = R ? P * R - 1 : null;

    const scores = {
      DP: scoreAround(P, S.base, 0.05),
      HFR: scoreAround(hr.weighted, S.base, 0.75 - S.base),
      VMI: 0.4 * vmiAtr + 0.3 * vmiRsi + 0.3 * vmiMacd,
      TNE: 100 * clamp((1 - H) / 0.3, 0, 1),
      PVM: EV === null ? 0 : scoreAround(EV, 0, 0.05),
    };
    const composite = 0.3 * scores.DP + 0.25 * scores.HFR + 0.15 * scores.VMI + 0.15 * scores.TNE + 0.15 * scores.PVM;
    const RTP = R ? R * S.base : null;
    const minScore = id === 'A' ? st.minScoreA : st.minScoreB;
    const fresh = ctx.freshness >= 1;

    const gates = [
      { key: 'data', ok: mk.prices.length >= MIN_TICKS, text: `${mk.prices.length}/${MIN_TICKS} ticks` },
      { key: 'feed', ok: fresh, text: fresh ? 'live feed' : 'feed stale' },
      { key: 'payout', ok: Boolean(R), text: pay && pay.error ? pay.error : R ? `payout ${R.toFixed(3)}×` : 'payout not priced yet' },
      { key: 'score', ok: composite >= minScore, text: `S_comp ${composite.toFixed(1)} / ${minScore}` },
      { key: 'ev', ok: EV !== null && EV * 100 >= st.minEV, text: EV === null ? 'EV unknown' : `EV ${fmtSigned(EV * 100, 1)}% / +${st.minEV}%` },
      { key: 'entropy', ok: H <= st.maxEntropy, text: `entropy ${H.toFixed(3)} / ${st.maxEntropy}` },
      { key: 'rtp', ok: RTP !== null && RTP * 100 >= st.minRTP, text: RTP === null ? 'payout efficiency unknown' : `payout eff. ${(RTP * 100).toFixed(1)}% / ${st.minRTP}%` },
    ];
    if (id === 'A') {
      gates.push({ key: 'adx', ok: ind.adx !== null && ind.adx > st.adxMinA, text: `ADX ${ind.adx === null ? '—' : ind.adx.toFixed(1)} / >${st.adxMinA}` });
      gates.push({ key: 'ema', ok: ind.ema9 !== null && ind.ema9 > ind.ema21, text: ind.ema9 !== null && ind.ema9 > ind.ema21 ? 'EMA 9 > EMA 21' : 'EMA 9 ≤ EMA 21' });
    } else {
      gates.push({ key: 'bb', ok: ind.bbRatio !== null && ind.bbRatio < st.bbMaxB, text: `BB width ${ind.bbRatio === null ? '—' : ind.bbRatio.toFixed(2)} / <${st.bbMaxB}` });
      gates.push({ key: 'rsi', ok: ind.rsi !== null && ind.rsi >= st.rsiLoB && ind.rsi <= st.rsiHiB, text: `RSI ${ind.rsi === null ? '—' : ind.rsi.toFixed(1)} / ${st.rsiLoB}–${st.rsiHiB}` });
    }
    const failed = gates.filter((g) => !g.ok);

    return {
      id,
      name: S.name,
      label: S.short,
      contract_type: S.contract_type,
      barrier: S.barrier,
      base: S.base,
      P,
      hr,
      H,
      R,
      IP: R ? 1 / R : null,
      EV,
      RTP,
      scores,
      composite,
      minScore,
      gates,
      failed,
      pass: failed.length === 0,
    };
  }

  function fmtSigned(x, dp) {
    return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(dp);
  }

  /**
   * mk:  { symbol, name, prices[], decimals, lastAt, interval, prior, strategies[], payouts{A,B} }
   * ctx: { now, duration, settings }
   */
  function evaluateMarket(mk, ctx) {
    const settings = Object.assign({}, DEFAULTS, ctx.settings || {});
    const out = { symbol: mk.symbol, name: mk.name, group: mk.group, status: mk.status || 'live', n: mk.prices.length };
    if (mk.prices.length < 60) {
      out.ready = false;
      out.msi = null;
      out.best = null;
      out.strategies = {};
      return out;
    }
    const m = measure(mk);
    const now = ctx.now || Date.now();
    const iv = mk.interval || 2000;
    const age = mk.lastAt ? now - mk.lastAt : Infinity;
    const freshness = age <= 3 * iv ? 1 : clamp(1 - (age - 3 * iv) / (7 * iv), 0, 1);
    const completeness = Math.min(1, mk.prices.length / WINDOW);
    const offered = (mk.strategies || []).some((id) => !(mk.payouts && mk.payouts[id] && mk.payouts[id].error));

    const strategies = {};
    for (const id of mk.strategies || []) strategies[id] = evaluateStrategy(id, mk, m, { duration: ctx.duration, settings, freshness });
    const list = Object.values(strategies);
    const passing = list.filter((s) => s.pass).sort((a, b) => b.composite - a.composite);
    const best = passing[0] || list.slice().sort((a, b) => b.composite - a.composite)[0] || null;

    const rtps = list.map((s) => s.RTP).filter((x) => x !== null);
    const S = 100 * freshness * (0.5 + 0.5 * completeness) * (offered ? 1 : 0);
    const L = rtps.length ? 100 * clamp((Math.max(...rtps) - 0.85) / 0.13, 0, 1) : 50;
    const msi = { V: m.V, E: m.E, T: m.T, S, L };
    msi.score = 0.3 * msi.V + 0.25 * msi.E + 0.2 * msi.T + 0.15 * msi.S + 0.1 * msi.L;

    return Object.assign(out, {
      ready: true,
      msi,
      ind: m.ind,
      zs: m.zs,
      spikes: m.spikes,
      freshness,
      strategies,
      best,
      offered,
    });
  }

  /** Rank markets by MSI; the pick is the highest-MSI market whose strategy clears every gate. */
  function rank(markets, ctx) {
    const rows = markets
      .filter((mk) => (mk.strategies || []).length)
      .map((mk) => evaluateMarket(mk, ctx));
    rows.sort((a, b) => (b.msi ? b.msi.score : -1) - (a.msi ? a.msi.score : -1));
    const selected = rows.find((r) => r.ready && r.best && r.best.pass) || null;
    return { rows, selected, top: rows.find((r) => r.ready) || null };
  }

  // --------------------------------------------------------------- staking
  /** Fractional Kelly. R = payout ÷ stake (e.g. 1.36). Returns fractions of balance. */
  function kelly(P, R, settings) {
    const st = Object.assign({}, DEFAULTS, settings || {});
    const b = R - 1;
    if (!(b > 0) || !(P > 0)) return { full: 0, fraction: 0, pct: 0, capped: false };
    const full = (P * b - (1 - P)) / b;
    const fraction = full * st.kellyFraction;
    const cap = st.maxStakePct / 100;
    return { full, fraction, pct: clamp(fraction, 0, cap), capped: fraction > cap };
  }

  function kellyStake(P, R, balance, settings) {
    const k = kelly(P, R, settings);
    return Object.assign(k, { stake: balance > 0 ? floor2(balance * k.pct) : 0 });
  }

  /** Any stake is limited to maxStakePct of the balance. */
  function capStake(stake, balance, settings) {
    const st = Object.assign({}, DEFAULTS, settings || {});
    if (!(balance > 0)) return stake;
    return Math.min(stake, floor2((balance * st.maxStakePct) / 100));
  }

  // ------------------------------------------------------------ daily risk
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Start-of-day record per account. Rolls over at local midnight unless a cooling-off pause is running. */
  function riskDay(prev, { now, today, balance }) {
    if (prev && prev.day === today) return prev;
    if (prev && prev.pausedUntil && prev.pausedUntil > now) return prev;
    return { day: today, start: Number(balance) || 0, pl: 0, pausedUntil: null, locked: false };
  }

  function riskLimits(day, settings) {
    const st = Object.assign({}, DEFAULTS, settings || {});
    return { ddLimit: round2((day.start * st.dailyDDPct) / 100), lockAt: round2((day.start * st.profitLockPct) / 100) };
  }

  function riskCheck(day, now, settings) {
    const lim = riskLimits(day, settings);
    if (day.pausedUntil && day.pausedUntil > now) return Object.assign({ ok: false, kind: 'pause', reason: 'daily drawdown limit hit — 24 h cooling-off', until: day.pausedUntil }, lim);
    if (day.locked) return Object.assign({ ok: false, kind: 'lock', reason: 'daily profit target locked in — back tomorrow' }, lim);
    return Object.assign({ ok: true }, lim);
  }

  function riskAfterTrade(day, profit, now, settings) {
    const next = Object.assign({}, day, { pl: round2(day.pl + (Number(profit) || 0)) });
    const lim = riskLimits(next, settings);
    let event = null;
    if (lim.ddLimit > 0 && next.pl <= -lim.ddLimit && !(next.pausedUntil > now)) {
      next.pausedUntil = now + DAY_MS;
      event = 'pause';
    } else if (lim.lockAt > 0 && next.pl >= lim.lockAt && !next.locked) {
      next.locked = true;
      event = 'lock';
    }
    return { day: next, event };
  }

  const api = {
    CATALOG,
    STRATEGIES,
    DEFAULTS,
    BAR_TICKS,
    MIN_TICKS,
    evaluateMarket,
    rank,
    kelly,
    kellyStake,
    capStake,
    riskDay,
    riskCheck,
    riskAfterTrade,
    riskLimits,
    indicators: { emaSeries, rsi, toBars, atr, adx, macdHist, bollingerWidths },
    stats: { chiToZ, digitUniformityZ, digitTransitionZ, lag1AutocorrZ, outcomeEntropy, densityProbability },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalIQ = api;
})(typeof window !== 'undefined' ? window : globalThis);
