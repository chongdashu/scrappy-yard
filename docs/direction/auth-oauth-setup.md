# Convex Auth — Google / GitHub / X setup

Date: 2026-11-05 (HKT). Web sign-in for Scrappy Yard leaderboard. Wavedash keeps its own host login (`wd:<id>`) and does **not** run Convex OAuth.

## Identity model (parallel, not linked)

| Host | Identity key (`players.guestId`) | Username |
|---|---|---|
| Web guest | random UUID (localStorage) | editable scrapyard name |
| Web + Google/GitHub/X | `auth:<convexUserId>` | Google: confirm modal (prefilled display name). GitHub/X: default to login/handle, editable |
| Wavedash | `wd:<wavedashUserId>` | Wavedash username (read-only) |

Boards share one Convex `players`/`runs` table; keys do not collide. No account linking yet.

## Already scaffolded in repo

- `convex/auth.ts` — Google, GitHub, Twitter/X providers + `afterUserCreatedOrUpdated` → player row
- `convex/auth.config.ts`, `convex/http.ts` — JWT issuer + OAuth HTTP routes
- `convex/schema.ts` — `...authTables` + player `authUserId` / `provider` / `needsUsernameConfirm`
- `convex/profile.ts` — `me`, `confirmUsername`, `setUsername`
- `game/src/auth.ts` — vanilla OAuth client (no React)
- Menu: Sign in Google / GitHub / X, Sign out, Google username modal

## Convex env (set on **dev** and **prod**)

```bash
# Site the OAuth flow returns to (production web)
npx convex env set SITE_URL https://scrappy-yard.vercel.app
# For local Vite testing, temporarily:
# npx convex env set SITE_URL http://localhost:5173

# JWT pair (generate once; keep private — do not commit)
# node scripts/generate-auth-keys.mjs   → then paste into env set

npx convex env set AUTH_GOOGLE_ID <client-id>
npx convex env set AUTH_GOOGLE_SECRET <client-secret>

npx convex env set AUTH_GITHUB_ID <client-id>
npx convex env set AUTH_GITHUB_SECRET <client-secret>

npx convex env set AUTH_TWITTER_ID <client-id>
npx convex env set AUTH_TWITTER_SECRET <client-secret>
```

Prod deployment (release builds): `https://rugged-hedgehog-932.convex.cloud`  
Dev deployment: `https://artful-fennec-528.convex.cloud`  
HTTP Actions / callback origin: replace `.cloud` with `.site`.

### Callback URLs (register on each OAuth app)

Dev:

- `https://artful-fennec-528.convex.site/api/auth/callback/google`
- `https://artful-fennec-528.convex.site/api/auth/callback/github`
- `https://artful-fennec-528.convex.site/api/auth/callback/twitter`

Prod:

- `https://rugged-hedgehog-932.convex.site/api/auth/callback/google`
- `https://rugged-hedgehog-932.convex.site/api/auth/callback/github`
- `https://rugged-hedgehog-932.convex.site/api/auth/callback/twitter`

Authorized JS origins (Google): `https://scrappy-yard.vercel.app`, `http://localhost:5173`

## What Chong-U needs to create

1. **Google Cloud** → Auth Platform → OAuth client (Web) with the callback URLs + origins above → `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`
2. **GitHub** → Settings → Developer settings → OAuth App → Homepage `https://scrappy-yard.vercel.app`, callback as above → `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`
3. **X Developer Portal** → Project → OAuth 2.0 app (confidential client), callback as above, scopes `users.read` (+ offline.access as requested by Auth.js) → `AUTH_TWITTER_ID` / `AUTH_TWITTER_SECRET`

Until those secrets exist, the menu buttons show and clicking them surfaces “Sign-in not ready (OAuth keys missing)”.

## Deploy notes

```bash
npx convex dev --once          # push functions to dev
npx convex deploy              # push to prod (rugged-hedgehog-932)
npm run deploy:web             # Vercel scrapyard-dash
```


## Live-only sign-in (2026-11-05)
- OAuth buttons are enabled only on `scrappy-yard.vercel.app` / `scrapyard-dash.vercel.app` production builds (`authLive()` in `game/src/auth.ts`).
- Localhost, Vite DEV, Vercel previews: buttons visible but greyed with "Live yard only"; `signInWith` refuses. Guest play unaffected.
- Only prod OAuth apps are configured; Convex `SITE_URL=https://scrappy-yard.vercel.app`. No localhost callbacks needed.

## Persistence (players row)
- `username` — provider default (Google → confirm modal; GitHub/X → handle), editable.
- `coins` — hex-nut wallet; every `leaderboard.submitRun` banks the run's nuts. No spend path yet (future shop).
- `unlocks` — SKU array (e.g. `skin_fox`); read via `profile.me` → `setOwnedSkus`. Skin selection UI still disabled.
- `linkedGuestId` / `mergedInto` — merge bookkeeping.

## Guest → account merge (first link only, `profile.linkGuest`)
- Runs once per signed-in player (when `linkedGuestId` unset), with this browser's guest UUID.
- coins: guest + account (summed); guest row zeroed and marked `mergedInto` so it can't be claimed twice.
- unlocks: union of account, guest row, and local `scrapyard.unlocks` flags.
- best run: max of the two; runs: summed. Guest row drops off the board.
- username: Google — guest name pre-fills the confirm modal; GitHub/X — keep handle (rename anytime).
- Later sign-ins on other browsers do not merge again. Wavedash (`wd:`) identities never merge.


## DodoPayments (skin IAP)

Set on **dev** and **prod** Convex deployments (never `VITE_*`):

```bash
npx convex env set DODO_PAYMENTS_API_KEY <key>
npx convex env set DODO_PAYMENTS_WEBHOOK_KEY <whsec_…>
# optional; defaults to live_mode in convex/dodo.ts
npx convex env set DODO_PAYMENTS_ENVIRONMENT live_mode
```

HTTP webhook: `https://<deployment>.convex.site/dodo-webhook`
