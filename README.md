# Musty BX

AI digit trading bot for Deriv synthetic indices. Users log in with their Deriv account (OAuth 2.0 + PKCE on Deriv's **new** API), and a six-layer digit engine picks Differs / Matches / Even-Odd / Over-Under trades, manually or on auto-trade with risk limits.

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

## The engine (`public/js/engine.js`)

Each layer estimates the next digit's probability; they're blended (weights in `DEFAULT_WEIGHTS`):

1. **Frequency** — share of each digit in the window
2. **Recency** — exponentially weighted share (~50-tick span)
3. **Gap** — overdue digits (capped)
4. **Cycle** — best repeating lag 2–30 that beats chance by 2 standard errors
5. **Entropy** — trusts the last-25-tick shape only when it's unusually orderly
6. **Streak & transition** — first-order Markov: what follows the current digit

Confidence = how far the blend leans from uniform. Synthetic-index digits are RNG-generated, so on pure random data the win rate converges to the baseline (the engine test shows ~90% for Differs, i.e. no edge). Treat it as a filter, not a guarantee, and test on demo.

## Auto-trade safety

One contract at a time · min confidence gate · max trades · take profit · stop loss (also refuses a stake that would break it) · optional martingale with a step cap · real accounts need an explicit "real money" tick · stops on any failed buy or a contract with no result after 2 minutes.

## Local testing

```
npm test            # engine unit tests
node test/e2e.js    # full browser test against a local mock of Deriv (needs Playwright)
```

`test/mock-deriv.js` imitates Deriv's OAuth server, REST API and both WebSockets, including PKCE verification and contract settlement.

Musty BX is an independent app built on the Deriv API and is not affiliated with Deriv.
