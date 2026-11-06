# Musty BX

AI trading bot for Deriv synthetic indices. Users log in with their Deriv account (OAuth 2.0 + PKCE on Deriv's **new** API). Two engines:

- **GoalIQ-Ultimate** (default) scans every supported synthetic index, auto-selects the market and trades Digit Over 2 / Digit Under 7 with quarter-Kelly staking and daily risk limits.
- **Six-layer digits** picks Differs / Matches / Even-Odd / Over-Under on the selected market.

No dependencies and no build step: static pages in `public/`, serverless functions in `api/`. Deploys to Vercel as-is.

## Deploy (Vercel)

1. Push this folder to a GitHub repo.
2. On vercel.com: **Add New → Project → Import** the repo. Name the project **`mustybx`** so the site is `https://mustybx.vercel.app`. Leave Framework as "Other" and the build settings empty. Deploy.
3. On developers.deriv.com → Apps → your app → pencil icon, the Redirect URL must be exactly:
   `https://mustybx.vercel.app/callback` (all lowercase).
4. Open the site, tap **Log in with Deriv**.

### Environment variables (optional)

| Name | Default | When to set |
|---|---|---|
| `DERIV_APP_ID` | `34QgKaYtPLMtQyvz5UhGx` | If you register a different app |
| `DERIV_REDIRECT_URI` | `https://<current host>/callback` | If you use a custom domain or the project name isn't `mustybx` |
| `DERIV_SCOPES` | `trade account_manage` | To request fewer/more scopes |

## How it works

```
Browser ──/login──▶ api/login.js ──302──▶ auth.deriv.com/oauth2/auth (PKCE S256)
        ◀──────────── Deriv redirects to /callback?code&state
/callback ─▶ api/callback.js ─POST─▶ auth.deriv.com/oauth2/token  (server-side only)
             token stored in an httpOnly cookie (never visible to page JS)

Dashboard:
  /api/accounts  → GET  api.derivws.com/trading/v1/options/accounts
  /api/otp       → POST .../accounts/{id}/otp → one-time wss:// URL (single use, ~120 s)
  Browser opens two sockets:
    • public  wss://api.derivws.com/trading/v1/options/ws/public  → ticks_history, ticks
    • trading OTP URL (…/ws/demo or …/ws/real)                     → balance, buy, proposal_open_contract
```

There is no refresh token on Deriv's new API; when the token expires the user is asked to log in again.

## GoalIQ-Ultimate (`public/js/goaliq.js`, `public/js/scanner.js`)

The scanner streams 16 symbols on the public socket (paced 250 ms apart) and prices each market's contract with a background `proposal` on the trading socket, so EV uses Deriv's real payout. Markets where Over/Under isn't offered are flagged and skipped.

| Strategy | Contract | Markets | Triggers |
|---|---|---|---|
| A · trend barrier breakout | Digit Over 2 | Vol 50, Vol 75 (both), Jump 50/75/100 | ADX > 28, EMA 9 > EMA 21, S_comp ≥ 78 |
| B · fortress range | Digit Under 7 | Vol 10, Vol 25 (both), Step, Jump 10/25 | BB width ÷ avg < 1.2, RSI 40–60, S_comp ≥ 88 |

Every trade also needs EV ≥ +5% vs the live payout, outcome entropy ≤ 0.85 bits and payout efficiency ≥ 92%. Vol 100 stays available for the six-layer engine only. Forex, commodities and Boom/Crash have no digit contracts, so they aren't scanned.

**Market Suitability Index** `0.30 V + 0.25 E + 0.20 T + 0.15 S + 0.10 L`
- V: steadiness of tick volatility, penalised for spikes, blended 70/30 with the spec's market hierarchy
- E: largest deviation from a fair random walk (digit uniformity, digit transitions, return autocorrelation; as z-scores)
- T: ADX on 5-tick bars plus EMA 9/21 alignment
- S: live, complete feed and the contract actually offered
- L: payout × fair win chance

**Composite score** `0.30 DP + 0.25 HFR + 0.15 VMI + 0.15 TNE + 0.15 PVM`
- DP: chance the settling digit lands in the win set, from the smoothed density of 1–2-tick price increments (in pips, wrapped to the last digit) applied to the current digit
- HFR: hit rate over the last 100 / 500 / 1000 ticks (75% scores 100)
- VMI: ATR 14/50 stability, RSI band, MACD histogram slope
- TNE: entropy of the win/loss given the starting digit (Miller–Madow corrected)
- PVM: EV = P × payout − 1 (+5% scores 100)

The pick is the highest-MSI market whose strategy clears every gate. Right before buying, the bot requests a fresh proposal, re-checks EV, then buys by proposal id.

**Risk:** stake = ¼ × Kelly `(P·b − (1−P)) / b`, capped at 3% of balance (fixed stakes are capped too). Each account keeps a start-of-day record in the browser: losing 10% of it pauses GoalIQ for 24 h; gaining 15% locks the day. All thresholds are editable under *Thresholds & risk limits*.

On markets driven by a fair random number generator, both contracts win about 70% of the time and Deriv's payout implies about 73%, so the +5% EV gate almost never opens and GoalIQ mostly stands aside. The unit tests check exactly that on random data, and check that the engine does detect real structure (a ±1-pip step walk).

## The six-layer engine (`public/js/engine.js`)

Each layer estimates the next digit's probability; they're blended (weights in `DEFAULT_WEIGHTS`):

1. **Frequency** — share of each digit in the window
2. **Recency** — exponentially weighted share (~50-tick span)
3. **Gap** — overdue digits (capped)
4. **Cycle** — best repeating lag 2–30 that beats chance by 2 standard errors
5. **Entropy** — trusts the last-25-tick shape only when it's unusually orderly
6. **Streak & transition** — first-order Markov: what follows the current digit

Confidence = how far the blend leans from uniform. Synthetic-index digits are RNG-generated, so on pure random data the win rate converges to the baseline (the engine test shows ~90% for Differs, i.e. no edge). Treat it as a filter, not a guarantee, and test on demo.

## Auto-trade safety

GoalIQ: every gate above + quarter-Kelly + 3% cap + daily drawdown pause / profit lock.

Both engines: one contract at a time · min confidence gate (six-layer) · max trades · take profit · stop loss (also refuses a stake that would break it) · optional martingale with a step cap (six-layer) · real accounts need an explicit "real money" tick · stops on any failed buy or a contract with no result after 2 minutes.

## Local testing

```
npm test            # six-layer + GoalIQ unit tests
node test/e2e.js    # full browser test against a local mock of Deriv (needs Playwright)
```

`test/mock-deriv.js` imitates Deriv's OAuth server, REST API and both WebSockets, including PKCE verification, per-symbol feeds (Volatility, Step, Jump), proposals, buy by proposal id or parameters, and contract settlement.

Musty BX is an independent app built on the Deriv API and is not affiliated with Deriv.
