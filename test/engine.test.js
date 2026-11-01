const assert = require('assert');
const E = require('../public/js/engine.js');

// lastDigit respects pip size (trailing zeros matter)
assert.strictEqual(E.lastDigit(1234.5, 2), 0);
assert.strictEqual(E.lastDigit(1234.57, 2), 7);
assert.strictEqual(E.lastDigit(987.123, 3), 3);
assert.strictEqual(E.lastDigit(5000, 2), 0);

// too little data
assert.strictEqual(E.analyze([1, 2, 3]), null);

// distributions sum to 1
const rnd = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 10));
const a = E.analyze(rnd, { window: 500 });
const sum = (x) => x.reduce((p, q) => p + q, 0);
assert(Math.abs(sum(a.combined) - 1) < 1e-9);
for (const k of Object.keys(a.layers)) assert(Math.abs(sum(a.layers[k].dist) - 1) < 1e-9, k);

// a strong cycle is detected
const cyc = Array.from({ length: 400 }, (_, i) => [3, 7, 1, 9, 5][i % 5]);
const ac = E.analyze(cyc);
assert.strictEqual(ac.layers.cycle.lag % 5, 0);
assert.strictEqual(ac.layers.cycle.predicted, 3);           // next in the cycle
assert.strictEqual(E.signal(ac, 'DIGITMATCH').barrier, '3');

// a never-seen digit is the Differs pick when data is skewed
const skew = Array.from({ length: 300 }, (_, i) => i % 9); // digit 9 never appears
const sd = E.signal(E.analyze(skew), 'DIGITDIFF');
assert.strictEqual(sd.contract_type, 'DIGITDIFF');

// strategy shapes
for (const s of ['DIGITDIFF', 'DIGITMATCH', 'EVENODD', 'OVERUNDER']) {
  const g = E.signal(a, s, 4);
  assert(g && g.contract_type && g.confidence >= 0 && g.confidence <= 100, s);
}
assert(['DIGITOVER', 'DIGITUNDER'].includes(E.signal(a, 'OVERUNDER', 4).contract_type));

// settlement rules
assert(E.settles('DIGITDIFF', '3', 4) && !E.settles('DIGITDIFF', '3', 3));
assert(E.settles('DIGITOVER', '4', 5) && !E.settles('DIGITOVER', '4', 4));
assert(E.settles('DIGITUNDER', '5', 4) && !E.settles('DIGITUNDER', '5', 5));
assert(E.settles('DIGITEVEN', null, 0) && E.settles('DIGITODD', null, 9));

// how often does random data clear each confidence bar? (to choose a sane default)
const hist = { DIGITDIFF: [], DIGITMATCH: [], EVENODD: [], OVERUNDER: [] };
const stream = Array.from({ length: 6000 }, () => Math.floor(Math.random() * 10));
let wins = 0, trades = 0;
for (let t = 500; t < stream.length - 1; t++) {
  const an = E.analyze(stream.slice(0, t + 1), { window: 500 });
  for (const s of Object.keys(hist)) hist[s].push(E.signal(an, s, 4).confidence);
  const g = E.signal(an, 'DIGITDIFF');
  if (g.confidence >= 40) { trades++; if (E.settles(g.contract_type, g.barrier, stream[t + 1])) wins++; }
}
const pct = (arr, bar) => (100 * arr.filter((c) => c >= bar).length / arr.length).toFixed(1);
for (const s of Object.keys(hist)) console.log(s, 'conf>=30:', pct(hist[s], 30) + '%', '>=50:', pct(hist[s], 50) + '%', '>=70:', pct(hist[s], 70) + '%');
console.log('Differs @conf>=40 on pure random data: trades', trades, 'win rate', (100 * wins / trades).toFixed(1) + '% (baseline 90%)');
console.log('engine tests passed');
