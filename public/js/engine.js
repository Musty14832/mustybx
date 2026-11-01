/*
 * Musty BX — six-layer last-digit analysis engine.
 *
 * Each layer turns the recent digit history into a probability estimate for
 * the NEXT digit (an array of 10 numbers that sums to 1). The layers are then
 * blended into one distribution, and a strategy turns that into a contract.
 *
 *   1. Frequency   – share of each digit over the whole window
 *   2. Recency     – exponentially weighted share (recent ticks count more)
 *   3. Gap         – "overdue" digits that haven't shown for a while
 *   4. Cycle       – repeating period (lag 2–30) that predicts the next digit
 *   5. Entropy     – trusts the short-window shape only when it's orderly
 *   6. Transition  – what tends to follow the current last digit (Markov) + streaks
 *
 * Synthetic-index digits come from a random number generator, so no layer has
 * a guaranteed edge. Confidence here means "how far the model leans from
 * uniform", not a promise of winning.
 *
 * Works in the browser (window.DigitEngine) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const UNIFORM = Object.freeze(Array(10).fill(0.1));

  const DEFAULT_WEIGHTS = Object.freeze({
    frequency: 0.25,
    recency: 0.2,
    gap: 0.15,
    cycle: 0.1,
    entropy: 0.1,
    transition: 0.2,
  });

  const LAYER_LABELS = Object.freeze({
    frequency: 'Frequency bias',
    recency: 'Recency weighting',
    gap: 'Gap analysis',
    cycle: 'Cycle detection',
    entropy: 'Entropy',
    transition: 'Streak & transition',
  });

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function normalize(arr) {
    const s = arr.reduce((a, b) => a + b, 0);
    if (!(s > 0)) return UNIFORM.slice();
    return arr.map((v) => v / s);
  }

  function blend(a, b, wB) {
    return a.map((v, i) => v * (1 - wB) + b[i] * wB);
  }

  function argmax(arr) {
    let k = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[k]) k = i;
    return k;
  }

  function argmin(arr) {
    let k = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[k]) k = i;
    return k;
  }

  function shannonNorm(dist) {
    let h = 0;
    for (const p of dist) if (p > 0) h -= p * Math.log2(p);
    return h / Math.log2(10);
  }

  /** Last digit of a quote, respecting the symbol's pip size (keeps trailing zeros). */
  function lastDigit(quote, pipSize) {
    const s = Number(quote).toFixed(Math.max(0, pipSize | 0));
    return s.charCodeAt(s.length - 1) - 48;
  }

  // ---- Layers --------------------------------------------------------------

  function frequencyLayer(d) {
    const c = Array(10).fill(0);
    for (const x of d) c[x]++;
    return { dist: normalize(c), counts: c };
  }

  function recencyLayer(d, span) {
    const alpha = 2 / (span + 1);
    let w = UNIFORM.slice();
    for (const x of d) {
      w = w.map((v, i) => v * (1 - alpha) + (i === x ? alpha : 0));
    }
    return { dist: normalize(w) };
  }

  function gapLayer(d) {
    const n = d.length;
    const lastSeen = Array(10).fill(-1);
    for (let i = 0; i < n; i++) lastSeen[d[i]] = i;
    const gaps = lastSeen.map((idx) => (idx < 0 ? n : n - 1 - idx));
    // Overdue score: grows with the gap, capped so one cold digit can't dominate.
    const score = gaps.map((g) => Math.min(g + 1, 40));
    return { dist: normalize(score), gaps };
  }

  function cycleLayer(d) {
    const n = d.length;
    const win = Math.min(n, 300);
    const start = n - win;
    let best = null;
    for (let lag = 2; lag <= 30; lag++) {
      let hits = 0;
      let total = 0;
      for (let t = Math.max(start, lag); t < n; t++) {
        total++;
        if (d[t] === d[t - lag]) hits++;
      }
      if (total < 20) continue;
      const rate = hits / total;
      // Only count it if it beats chance (10%) by ~2 standard errors.
      const margin = 2 * Math.sqrt((0.1 * 0.9) / total);
      const excess = rate - 0.1 - margin;
      if (excess > 0 && (!best || excess > best.excess)) best = { lag, rate, excess, total };
    }
    if (!best) return { dist: UNIFORM.slice(), lag: null, rate: null, predicted: null, strength: 0 };
    const predicted = d[n - best.lag];
    const strength = clamp((best.rate - 0.1) / 0.15, 0, 1) * 0.6;
    const onehot = UNIFORM.map((_, i) => (i === predicted ? 1 : 0));
    return { dist: blend(UNIFORM.slice(), onehot, strength), lag: best.lag, rate: best.rate, predicted, strength };
  }

  function entropyLayer(d, shortWin) {
    const tail = d.slice(-shortWin);
    const fullH = shannonNorm(frequencyLayer(d.slice(-100)).dist);
    const shortDist = frequencyLayer(tail).dist;
    const shortH = shannonNorm(shortDist);
    // 25 random ticks typically score ~0.88–0.95; below that the window is "orderly".
    const orderliness = clamp((0.95 - shortH) / 0.15, 0, 1);
    return { dist: blend(UNIFORM.slice(), shortDist, orderliness), entropy: fullH, shortEntropy: shortH, orderliness };
  }

  function transitionLayer(d) {
    const n = d.length;
    const last = d[n - 1];
    const row = Array(10).fill(1); // Laplace smoothing
    for (let i = 1; i < n; i++) if (d[i - 1] === last) row[d[i]]++;

    // Streaks reported for the UI (and used by nothing else here).
    let same = 1;
    for (let i = n - 2; i >= 0 && d[i] === last; i--) same++;
    const parity = last % 2;
    let parityLen = 1;
    for (let i = n - 2; i >= 0 && d[i] % 2 === parity; i--) parityLen++;
    const high = last >= 5;
    let sideLen = 1;
    for (let i = n - 2; i >= 0 && (d[i] >= 5) === high; i--) sideLen++;

    return {
      dist: normalize(row),
      last,
      streak: { digit: last, length: same, parity: parity ? 'odd' : 'even', parityLength: parityLen, side: high ? 'high (5–9)' : 'low (0–4)', sideLength: sideLen },
    };
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * @param {number[]} digits  history, oldest first
   * @param {object}   opts    { window, span, shortWindow, weights }
   */
  function analyze(digits, opts = {}) {
    const windowSize = opts.window || 500;
    const d = digits.slice(-windowSize);
    if (d.length < 30) return null;

    const weights = Object.assign({}, DEFAULT_WEIGHTS, opts.weights || {});
    const layers = {
      frequency: frequencyLayer(d),
      recency: recencyLayer(d, opts.span || 50),
      gap: gapLayer(d),
      cycle: cycleLayer(d),
      entropy: entropyLayer(d, opts.shortWindow || 25),
      transition: transitionLayer(d),
    };

    let combined = Array(10).fill(0);
    let wSum = 0;
    for (const k of Object.keys(layers)) {
      const w = Math.max(0, Number(weights[k]) || 0);
      wSum += w;
      combined = combined.map((v, i) => v + w * layers[k].dist[i]);
    }
    combined = wSum > 0 ? normalize(combined) : UNIFORM.slice();

    return {
      n: d.length,
      lastDigit: d[d.length - 1],
      counts: layers.frequency.counts,
      layers,
      combined,
      entropy: layers.entropy.entropy,
      streak: layers.transition.streak,
    };
  }

  // Map an edge (0 = no lean, 1 = strong lean) to a 0–100 confidence.
  const toConfidence = (edge) => Math.round(clamp(edge / 0.6, 0, 1) * 100);

  /**
   * Turn an analysis into a tradable signal.
   * strategy: 'DIGITDIFF' | 'DIGITMATCH' | 'EVENODD' | 'OVERUNDER'
   * barrier:  only for OVERUNDER (1–8)
   */
  function signal(analysis, strategy, barrier) {
    if (!analysis) return null;
    const c = analysis.combined;

    if (strategy === 'DIGITDIFF') {
      const digit = argmin(c);
      const edge = (0.1 - c[digit]) / 0.1;
      return { contract_type: 'DIGITDIFF', barrier: String(digit), label: `Differs ${digit}`, confidence: toConfidence(edge), modelWin: 1 - c[digit], baseline: 0.9 };
    }

    if (strategy === 'DIGITMATCH') {
      const digit = argmax(c);
      const edge = (c[digit] - 0.1) / 0.1;
      return { contract_type: 'DIGITMATCH', barrier: String(digit), label: `Matches ${digit}`, confidence: toConfidence(edge), modelWin: c[digit], baseline: 0.1 };
    }

    if (strategy === 'EVENODD') {
      const pEven = c[0] + c[2] + c[4] + c[6] + c[8];
      const even = pEven >= 0.5;
      const p = even ? pEven : 1 - pEven;
      const edge = (p - 0.5) / 0.1;
      return { contract_type: even ? 'DIGITEVEN' : 'DIGITODD', barrier: null, label: even ? 'Even' : 'Odd', confidence: toConfidence(edge), modelWin: p, baseline: 0.5 };
    }

    if (strategy === 'OVERUNDER') {
      const b = clamp(parseInt(barrier, 10) || 4, 1, 8);
      let pOver = 0;
      let pUnder = 0;
      for (let i = 0; i < 10; i++) {
        if (i > b) pOver += c[i];
        if (i < b) pUnder += c[i];
      }
      const baseOver = (9 - b) / 10;
      const baseUnder = b / 10;
      const rOver = pOver / baseOver;
      const rUnder = pUnder / baseUnder;
      const over = rOver >= rUnder;
      const ratio = over ? rOver : rUnder;
      const edge = (ratio - 1) / 0.5;
      return {
        contract_type: over ? 'DIGITOVER' : 'DIGITUNDER',
        barrier: String(b),
        label: over ? `Over ${b}` : `Under ${b}`,
        confidence: toConfidence(edge),
        modelWin: over ? pOver : pUnder,
        baseline: over ? baseOver : baseUnder,
      };
    }

    return null;
  }

  /** Did a finished contract win, given its type, barrier and exit digit? (used by the mock + tests) */
  function settles(contractType, barrier, digit) {
    const b = parseInt(barrier, 10);
    switch (contractType) {
      case 'DIGITDIFF': return digit !== b;
      case 'DIGITMATCH': return digit === b;
      case 'DIGITEVEN': return digit % 2 === 0;
      case 'DIGITODD': return digit % 2 === 1;
      case 'DIGITOVER': return digit > b;
      case 'DIGITUNDER': return digit < b;
      default: return false;
    }
  }

  const api = { analyze, signal, lastDigit, settles, DEFAULT_WEIGHTS, LAYER_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DigitEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
