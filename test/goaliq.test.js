const assert = require('assert');
const G = require('../public/js/goaliq.js');

const I = G.indicators;
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
function gauss() { let u = 0; let v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const round = (x, dp) => Number(x.toFixed(dp));

function randomWalk(n, start, sigma, dp) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) { p = round(p + gauss() * sigma, dp); out.push(p); }
  return out;
}
function stepWalk(n, start) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) { p = round(p + (Math.random() < 0.5 ? -0.1 : 0.1), 1); out.push(p); }
  return out;
}
const payoutsFor = (ids, R) => Object.fromEntries(ids.map((id) => [id, { R }]));
const DERIV_LIKE_R = (1 / 0.7) * 0.955; // ~4.5% under fair odds
const now = Date.now();
const market = (o) => Object.assign({ name: o.symbol, lastAt: now, interval: 1000, prior: 100, status: 'live' }, o);

// ---- indicators
const up = Array.from({ length: 60 }, (_, i) => 100 + i);
assert.strictEqual(I.rsi(up, 14), 100, 'RSI of a straight rise');
assert.strictEqual(I.rsi(Array(30).fill(5), 14), 50, 'RSI of a flat line');
const ema = I.emaSeries([1, 2, 3, 4, 5], 3);
near(ema[4], 4.0625, 1e-9, 'EMA');
const trendBars = I.toBars(Array.from({ length: 500 }, (_, i) => 1000 + i * 0.5 + gauss() * 0.05));
const noiseBars = I.toBars(randomWalk(500, 1000, 0.5, 2));
assert(I.adx(trendBars).adx > 60, 'ADX high in a clean trend: ' + I.adx(trendBars).adx);
assert(I.adx(trendBars).pdi > I.adx(trendBars).mdi, '+DI leads in an uptrend');
assert.strictEqual(I.toBars([1, 2, 3, 4, 5, 6, 7], 5).length, 1, 'bars align to the newest tick');
assert(I.macdHist(up.concat(up.map((x) => x + 60))).length > 0);

// ---- stats
const S = G.stats;
const randDigits = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 10));
assert(Math.abs(S.digitUniformityZ(randDigits)) < 4.5, 'fair digits look fair');
assert(S.digitUniformityZ(Array.from({ length: 1000 }, (_, i) => (i % 3))) > 10, 'skewed digits flagged');
const st500 = Array.from({ length: 5000 }, () => Math.floor(Math.random() * 10));
near(S.outcomeEntropy(st500, st500.map(() => (Math.random() < 0.7 ? 1 : 0))), 0.881, 0.03, 'entropy of a 70% coin given unrelated digits');
assert(S.outcomeEntropy(st500, st500.map((d) => (d < 6 ? 1 : 0))) < 0.05, 'outcome fully decided by the start digit');

// ---- Kelly + caps
const k1 = G.kelly(0.8, 1.4);
near(k1.full, 0.3, 1e-9, 'full Kelly');
near(k1.fraction, 0.075, 1e-9, 'quarter Kelly');
near(k1.pct, 0.03, 1e-9, '3% cap');
assert(k1.capped);
assert.strictEqual(G.kelly(0.7, DERIV_LIKE_R).pct, 0, 'no stake without an edge');
assert.strictEqual(G.kellyStake(0.8, 1.4, 1000).stake, 30, 'stake in money');
assert.strictEqual(G.kellyStake(0.73, 1.4, 1000).stake, 13.75, 'uncapped quarter-Kelly stake');
assert.strictEqual(G.capStake(50, 1000), 30, 'manual stakes are capped too');

// ---- risk guard
let day = G.riskDay(null, { now, today: '2026-11-06', balance: 1000 });
assert.deepStrictEqual([day.start, day.pl, day.locked], [1000, 0, false]);
assert(G.riskCheck(day, now).ok);
let r = G.riskAfterTrade(day, -60, now);
assert.strictEqual(r.event, null);
r = G.riskAfterTrade(r.day, -40, now);
assert.strictEqual(r.event, 'pause', '10% drawdown pauses');
day = r.day;
assert(!G.riskCheck(day, now + 1000).ok);
assert.strictEqual(G.riskDay(day, { now: now + 3600e3, today: '2026-11-07', balance: 900 }), day, 'pause survives midnight');
const fresh = G.riskDay(day, { now: now + 25 * 3600e3, today: '2026-11-07', balance: 900 });
assert(fresh.start === 900 && G.riskCheck(fresh, now + 25 * 3600e3).ok, 'resets after 24 h');
let lock = G.riskAfterTrade(G.riskDay(null, { now, today: 'x', balance: 1000 }), 150, now);
assert.strictEqual(lock.event, 'lock', '15% profit locks the day');
assert.strictEqual(G.riskCheck(lock.day, now).kind, 'lock');

// ---- random markets: the gates should almost never open
let passes = 0;
let evals = 0;
const pcs = [];
for (let trial = 0; trial < 40; trial++) {
  const sym = trial % 2 ? '1HZ25V' : '1HZ75V';
  const strategies = trial % 2 ? ['B'] : ['A'];
  const mk = market({ symbol: sym, strategies, decimals: 2, prices: randomWalk(1200, 5000, 0.6, 2), payouts: payoutsFor(strategies, DERIV_LIKE_R) });
  const ev = G.evaluateMarket(mk, { now, duration: 1 });
  evals++;
  if (ev.best.pass) passes++;
  pcs.push(ev.best.P);
  assert(ev.msi.score >= 0 && ev.msi.score <= 100, 'MSI range');
  for (const k of ['V', 'E', 'T', 'S', 'L']) assert(ev.msi[k] >= 0 && ev.msi[k] <= 100, k);
  for (const k of ['DP', 'HFR', 'VMI', 'TNE', 'PVM']) assert(ev.best.scores[k] >= 0 && ev.best.scores[k] <= 100, k);
  assert(ev.best.EV < 0.05, 'no +5% EV on fair random digits');
}
assert.strictEqual(passes, 0, 'random markets never clear the GoalIQ gates');
const avgP = pcs.reduce((a, b) => a + b, 0) / pcs.length;
near(avgP, 0.7, 0.02, 'model probability stays near 70% on fair digits');

// ---- missing payout / digits not offered
const noPay = G.evaluateMarket(market({ symbol: 'R_10', strategies: ['B'], decimals: 3, prices: randomWalk(1000, 6000, 0.3, 3) }), { now });
assert(!noPay.best.pass && noPay.best.failed.some((g) => g.key === 'payout'));
const notOffered = G.evaluateMarket(market({ symbol: 'stpRNG', strategies: ['B'], decimals: 1, prices: stepWalk(1000, 8000), payouts: { B: { error: 'Digits not offered' } } }), { now });
assert.strictEqual(notOffered.msi.S, 0, 'no execution score without the contract');

// ---- a structured market (Step-like ±1 pip): the engine sees the structure
const step = stepWalk(1200, 8000);
const stepMk = market({ symbol: 'stpRNG', strategies: ['B'], decimals: 1, prices: step, payouts: payoutsFor(['B'], DERIV_LIKE_R), prior: 85 });
const se = G.evaluateMarket(stepMk, { now, duration: 1 });
assert(se.msi.E > 90, 'E flags the non-random digit transitions: ' + se.msi.E);
const curDigit = Math.round(step[step.length - 1] * 10) % 10;
const b = se.strategies.B;
if (curDigit >= 2 && curDigit <= 4) assert(b.P > 0.95, `digit ${curDigit} can't reach 7 (or wrap to 9) in 1–2 steps: P=${b.P}`);
if (curDigit === 8) assert(b.P < 0.3, `digit 8 needs 2 steps down: P=${b.P}`);
assert(b.H < 0.85, 'Under-7 outcome on a step walk is mostly decided by the start digit (low entropy): ' + b.H);
assert(!b.pass || b.composite >= 88, 'spec S_comp gate still applies');
// Loosen only S_comp: now a low current digit should be tradable.
let tradable = 0;
for (let i = 0; i < 30; i++) {
  const s2 = stepWalk(1200, 8000);
  const d = Math.round(s2[s2.length - 1] * 10) % 10;
  const e2 = G.evaluateMarket(market({ symbol: 'stpRNG', strategies: ['B'], decimals: 1, prices: s2, payouts: payoutsFor(['B'], DERIV_LIKE_R) }), { now, duration: 1, settings: { minScoreB: 0, bbMaxB: 99, rsiLoB: 0, rsiHiB: 100 } });
  if (d >= 2 && d <= 4) { assert(e2.best.pass, 'low digit on step walk passes with loose S_comp/BB/RSI: ' + e2.best.failed.map((g) => g.text).join(', ')); tradable++; }
  if ([0, 6, 7, 8, 9].includes(d)) assert(!e2.best.pass, `digit ${d} can reach 7–9 next, so no trade`);
}
assert(tradable > 0);

// ---- ranking
const mkts = [
  market({ symbol: 'R_25', strategies: ['B'], decimals: 3, prices: randomWalk(1000, 3000, 0.3, 3), payouts: payoutsFor(['B'], DERIV_LIKE_R) }),
  market({ symbol: 'R_50', strategies: ['A'], decimals: 4, prices: randomWalk(1000, 200, 0.05, 4), payouts: payoutsFor(['A'], DERIV_LIKE_R), prior: 70 }),
  market({ symbol: 'R_100', strategies: [], decimals: 2, prices: randomWalk(1000, 1000, 0.6, 2) }),
  market({ symbol: 'JD10', strategies: ['B'], decimals: 2, prices: randomWalk(30, 1000, 0.6, 2) }),
];
const rk = G.rank(mkts, { now });
assert.strictEqual(rk.rows.length, 3, 'markets with no GoalIQ strategy are skipped');
assert.strictEqual(rk.selected, null, 'nothing selected on random data');
assert(rk.rows[rk.rows.length - 1].symbol === 'JD10' && !rk.rows[rk.rows.length - 1].ready, 'loading markets sink to the bottom');
for (let i = 1; i < rk.rows.length - 1; i++) assert(rk.rows[i - 1].msi.score >= rk.rows[i].msi.score, 'sorted by MSI');

// catalog sanity
for (const c of G.CATALOG) for (const s of c.strategies) assert(G.STRATEGIES[s]);
assert.strictEqual(G.STRATEGIES.A.contract_type, 'DIGITOVER');
assert.strictEqual(G.STRATEGIES.B.contract_type, 'DIGITUNDER');

console.log(`random markets: ${passes}/${evals} passed · mean model P ${avgP.toFixed(3)}`);
console.log(`step walk: E ${se.msi.E.toFixed(0)} · digit ${curDigit} · P(Under 7) ${b.P.toFixed(3)} · S_comp ${b.composite.toFixed(1)} · entropy ${b.H.toFixed(3)}`);
console.log('goaliq tests passed');
