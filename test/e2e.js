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

  try {
    // 1. Landing
    await page.goto('http://localhost:3000/');
    await page.screenshot({ path: path.join(ROOT, 'test/out-landing.png'), fullPage: true });
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
    const label = await page.textContent('#signalLabel');
    assert(/^Differs \d$/.test(label), 'default strategy is Differs: ' + label);
    assert(!(await page.isVisible('#realAck')), 'real-money checkbox must be hidden on demo');
    assert(!(await page.isVisible('#martingaleRow')), 'martingale settings hidden until enabled');
    assert(!(await page.isVisible('#barrierField')), 'barrier only for Over/Under');
    await page.screenshot({ path: path.join(ROOT, 'test/out-mobile-top.png') });

    // 5. Manual trade
    await page.click('#tradeNow');
    await page.waitForSelector('#tradeLog tr.won, #tradeLog tr.lost', { timeout: 10000 });
    assert.strictEqual(await page.textContent('#stTrades'), '1');

    // 6. Each strategy produces a valid contract the mock accepts
    for (const s of ['DIGITMATCH', 'EVENODD', 'OVERUNDER']) {
      await page.selectOption('#strategySelect', s);
      await sleep(300);
      const before = await page.$$eval('#tradeLog tr.won, #tradeLog tr.lost', (r) => r.length);
      await page.click('#tradeNow');
      await page.waitForFunction((n) => document.querySelectorAll('#tradeLog tr.won, #tradeLog tr.lost').length > n, before, { timeout: 10000 });
    }
    await page.selectOption('#strategySelect', 'DIGITDIFF');

    // 7. Auto-trade stops at max trades
    await page.fill('#minConf', '0');
    await page.fill('#maxTrades', '4');
    await page.fill('#takeProfit', '0');
    await page.fill('#stopLoss', '0');
    await page.check('#martingale');
    await page.click('#autoBtn');
    await page.waitForFunction(() => /max trades reached/.test(document.getElementById('autoStatus').textContent), null, { timeout: 30000 });
    const trades = Number(await page.textContent('#stTrades'));
    assert.strictEqual(trades, 8, 'expected 4 manual + 4 auto trades, got ' + trades);

    // 8. Stop-loss stops the bot
    await page.click('#clearLog');
    await page.fill('#maxTrades', '100');
    await page.fill('#stopLoss', '1.5');
    await page.selectOption('#strategySelect', 'DIGITMATCH'); // loses most of the time
    await page.uncheck('#martingale');
    await page.click('#autoBtn');
    await page.waitForFunction(() => /stop loss|break the stop loss/.test(document.getElementById('autoStatus').textContent), null, { timeout: 60000 });

    await page.selectOption('#strategySelect', 'DIGITDIFF');
    await page.click('#signalCard details summary');
    await sleep(400);
    await page.screenshot({ path: path.join(ROOT, 'test/out-dashboard.png'), fullPage: true });

    // Desktop layout screenshot
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'test/out-desktop.png'), fullPage: true });

    // 9. Logout clears session
    await page.goto('http://localhost:3000/logout');
    await page.waitForURL('http://localhost:3000/');
    assert(!(await ctx.cookies()).find((c) => c.name === 'mbx_token'));

    const calls = await (await fetch('http://localhost:4100/__calls')).json();
    console.log('mock saw:', [...new Set(calls.filter((c) => !c.startsWith('SETTLE')))].join(' | '));
    assert.deepStrictEqual(errors, [], 'browser errors: ' + errors.join('\n'));
    console.log('E2E PASSED');
  } catch (e) {
    await page.screenshot({ path: path.join(ROOT, 'test/out-failure.png'), fullPage: true }).catch(() => {});
    console.error('E2E FAILED:', e.message);
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    mock.kill();
    app.kill();
  }
})();
