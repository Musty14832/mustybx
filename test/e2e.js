// End-to-end: real Chromium against the app + mock Deriv.
// Run: node test/e2e.js   (starts both servers itself)
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const env = {
  ...process.env,
  DERIV_AUTH_BASE: 'http://localhost:4100',
  DERIV_API_BASE: 'http://localhost:4100',
  DERIV_PUBLIC_WS: 'ws://localhost:4100/trading/v1/options/ws/public',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name, full = false) => page.screenshot({ path: path.join(ROOT, `test/out-${name}.png`), fullPage: full });

(async () => {
  const mock = spawn('node', [path.join(__dirname, 'mock-deriv.js')], { env, stdio: 'inherit' });
  const app = spawn('node', [path.join(__dirname, 'serve.js')], { env, stdio: 'inherit' });
  await sleep(800);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const text = (sel) => page.textContent(sel);
  const settled = () => page.$$eval('#tradeLog tr.won, #tradeLog tr.lost', (r) => r.length);

  try {
    // 1. Landing
    await page.goto('http://localhost:3000/');
    await shot(page, 'landing', true);
    assert(await page.isVisible('text=Log in with Deriv'));

    // 2. Unauthenticated dashboard bounces home
    await page.goto('http://localhost:3000/app');
    await page.waitForURL('http://localhost:3000/');

    // 3. OAuth round-trip (PKCE verified by mock)
    await page.click('text=Log in with Deriv');
    await page.waitForURL('http://localhost:3000/app', { timeout: 10000 });
    const cookies = await ctx.cookies();
    const tok = cookies.find((c) => c.name === 'mbx_token');
    assert(tok && tok.httpOnly, 'token cookie must be httpOnly');
    assert(!cookies.find((c) => c.name === 'mbx_pkce' && c.value), 'pkce cookie cleared');

    // 4. Accounts + trading socket + market data
    await page.waitForSelector('#dash:not([hidden])');
    await page.waitForFunction(() => document.getElementById('modeBadge').textContent === 'DEMO', null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('balance').textContent.includes('USD'));
    await page.waitForFunction(() => !/Waiting|Collecting/.test(document.getElementById('signalLabel').textContent), null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('connDot').className.includes('ok'));
    assert(/^Differs \d$/.test(await text('#signalLabel')), 'six-layer card still shows its signal');
    assert.strictEqual(await page.inputValue('#engineSelect'), 'goaliq', 'GoalIQ is the default engine');
    assert(!(await page.isVisible('#minConfField')) && !(await page.isVisible('#martingaleWrap')), 'six-layer-only controls hidden in GoalIQ mode');
    assert(!(await page.isVisible('#stakeField')), 'stake input hidden under Kelly sizing');
    assert(!(await page.isVisible('#realAck')), 'real-money checkbox must be hidden on demo');

    // 5. GoalIQ scanner: every catalog market loads, Step is flagged, payouts priced
    await page.waitForFunction(() => document.querySelectorAll('#rankBody tr[data-symbol]').length === 14, null, { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('#rankBody tr[data-symbol]')].filter((r) => !r.classList.contains('wait')).length === 14, null, { timeout: 30000 });
    await page.waitForFunction(() => !/pricing/.test(document.getElementById('goalScanInfo').textContent), null, { timeout: 30000 });
    const rows = await page.$$eval('#rankBody tr[data-symbol]', (rs) => rs.map((r) => ({ sym: r.dataset.symbol, msi: Number(r.children[2].textContent), status: r.lastChild.textContent, ev: r.children[6].textContent })));
    for (let i = 1; i < rows.length; i++) assert(rows[i - 1].msi >= rows[i].msi, 'ranked by MSI');
    const step = rows.find((r) => r.sym === 'stpRNG');
    assert(/not offered/.test(step.status), 'Step Index flagged as no Over/Under: ' + step.status);
    for (const r of rows.filter((x) => x.sym !== 'stpRNG')) assert(/%/.test(r.ev), `EV shown for ${r.sym}: ${r.ev}`);
    assert.strictEqual(await text('#goalPick'), 'Standing aside', 'spec gates keep the bot out of fair random markets');
    assert((await page.$$('#goalGates .gate.no')).length > 0, 'failed gates are listed');
    assert(/Today: \+?0\.00/.test(await text('#riskLine')), 'risk line: ' + (await text('#riskLine')));
    await shot(page, 'mobile-top');

    // Breakdown for a tapped row
    await page.click('#rankBody tr[data-symbol="R_25"]');
    await page.waitForFunction(() => /Volatility 25 ·/.test(document.getElementById('bdName').textContent));
    assert.strictEqual(await page.$$eval('#bdMsi .bd-row', (r) => r.length), 5);
    assert.strictEqual(await page.$$eval('#bdComp .bd-row', (r) => r.length), 5);
    assert(/Deriv payout 1\.36/.test(await text('#bdInd')), 'payout read from the proposal');

    // 6. Manual GoalIQ trade with spec defaults refuses
    await page.click('#tradeNow');
    await page.waitForFunction(() => /No market clears every GoalIQ gate/.test(document.getElementById('notice').textContent));
    assert.strictEqual(await settled(), 0);

    // 7. Six-layer engine still works (manual, every strategy, auto with martingale)
    await page.selectOption('#engineSelect', 'six');
    assert(await page.isVisible('#minConfField') && await page.isVisible('#stakeField'));
    await page.click('#tradeNow');
    await page.waitForFunction(() => document.querySelectorAll('#tradeLog tr.won, #tradeLog tr.lost').length === 1, null, { timeout: 10000 });
    for (const s of ['DIGITMATCH', 'EVENODD', 'OVERUNDER']) {
      await page.selectOption('#strategySelect', s);
      await sleep(300);
      const before = await settled();
      await page.click('#tradeNow');
      await page.waitForFunction((n) => document.querySelectorAll('#tradeLog tr.won, #tradeLog tr.lost').length > n, before, { timeout: 10000 });
    }
    await page.selectOption('#strategySelect', 'DIGITDIFF');
    await page.fill('#minConf', '0');
    await page.fill('#maxTrades', '4');
    await page.fill('#takeProfit', '0');
    await page.fill('#stopLoss', '0');
    await page.check('#martingale');
    await page.click('#autoBtn');
    await page.waitForFunction(() => /max trades reached/.test(document.getElementById('autoStatus').textContent), null, { timeout: 30000 });
    assert.strictEqual(Number(await text('#stTrades')), 8, 'expected 4 manual + 4 auto six-layer trades');
    await page.uncheck('#martingale');

    // 8. GoalIQ auto, loosened gates, Kelly: passes but Kelly stakes 0 on negative EV
    await page.selectOption('#engineSelect', 'goaliq');
    await page.click('#goalSettings summary');
    const loose = { gMinScoreA: '0', gMinScoreB: '0', gMinEV: '-100', gMaxEntropy: '1', gMinRTP: '0', gAdxMinA: '0', gBbMaxB: '99', gRsiLoB: '0', gRsiHiB: '100' };
    for (const [id, v] of Object.entries(loose)) await page.fill('#' + id, v);
    await page.waitForFunction(() => document.getElementById('goalPick').classList.contains('go'), null, { timeout: 5000 });
    await page.fill('#maxTrades', '3');
    await page.click('#autoBtn');
    await page.waitForFunction(() => /Kelly says 0/.test(document.getElementById('autoStatus').textContent), null, { timeout: 5000 });
    assert.strictEqual(Number(await text('#stTrades')), 8, 'Kelly placed nothing without an edge');
    await page.click('#autoBtn'); // stop

    // 9. GoalIQ auto, fixed stake: trades the auto-selected market via proposal → buy
    await page.selectOption('#sizingSelect', 'fixed');
    await page.fill('#stake', '1');
    await page.click('#autoBtn');
    await page.waitForFunction(() => /max trades reached/.test(document.getElementById('autoStatus').textContent), null, { timeout: 30000 });
    assert.strictEqual(Number(await text('#stTrades')), 11, '3 GoalIQ trades');
    const goalRows = await page.$$eval('#tradeLog tr', (rs) => rs.map((r) => r.children[1] && r.children[1].textContent).filter((t) => /^GoalIQ/.test(t || '')));
    assert.strictEqual(goalRows.length, 3);
    for (const t of goalRows) assert(/^GoalIQ (Over 2|Under 7) · (1HZ|R_|JD)\w+ · auto$/.test(t), 'GoalIQ row: ' + t);

    // 10. 3% stake cap on a big fixed stake (manual)
    await page.fill('#stake', '1000');
    const capBefore = await settled();
    await page.click('#tradeNow');
    await page.waitForFunction((n) => document.querySelectorAll('#tradeLog tr.won, #tradeLog tr.lost').length > n, capBefore, { timeout: 10000 });
    const capStake = Number(await page.$eval('#tradeLog tr td:nth-child(3)', (td) => td.textContent));
    assert(capStake > 250 && capStake <= 300.5, 'stake capped at 3% of ~10,000: ' + capStake);
    await page.fill('#stake', '1');

    // 11. Daily risk guard: tiny limits → the next GoalIQ result pauses or locks the day
    await page.fill('#gDD', '0.001');
    await page.fill('#gLock', '0.001');
    await page.fill('#maxTrades', '50');
    await page.click('#autoBtn');
    await page.waitForFunction(() => /daily/.test(document.getElementById('autoStatus').textContent), null, { timeout: 30000 });
    const riskText = await text('#riskLine');
    assert(/Cooling-off until|Profit locked/.test(riskText), 'risk line shows the block: ' + riskText);
    await page.click('#autoBtn');
    await page.waitForFunction(() => /^GoalIQ: daily/.test(document.getElementById('notice').textContent));
    assert(!/Stop auto-trade/.test(await text('#autoBtn')), 'cannot restart while blocked');

    // Restore defaults; screenshots
    await page.click('#goalReset');
    await page.selectOption('#sizingSelect', 'kelly');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1200);
    await shot(page, 'dashboard', true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(1200);
    await shot(page, 'desktop', true);

    // No horizontal overflow on mobile
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, 'page wider than the phone by ' + overflow + 'px');

    // 12. Logout clears session
    await page.goto('http://localhost:3000/logout');
    await page.waitForURL('http://localhost:3000/');
    assert(!(await ctx.cookies()).find((c) => c.name === 'mbx_token'));

    const calls = await (await fetch('http://localhost:4100/__calls')).json();
    const kinds = [...new Set(calls.filter((c) => !/^SETTLE|^BUY/.test(c)))];
    console.log('mock saw:', kinds.join(' | '));
    assert(calls.some((c) => c.startsWith('BUY-ID')) && calls.some((c) => c.startsWith('BUY-DIRECT')), 'both buy paths used');
    assert(!calls.some((c) => /^BUY.* stpRNG /.test(c)), 'never bought on a market without the contract');
    assert.deepStrictEqual(errors, [], 'browser errors: ' + errors.join('\n'));
    console.log('E2E PASSED');
  } catch (e) {
    await shot(page, 'failure', true).catch(() => {});
    console.error('E2E FAILED:', e.message);
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    mock.kill();
    app.kill();
  }
})();
