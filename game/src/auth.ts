// Vanilla Convex Auth client (no React). Mirrors @convex-dev/auth/react token + OAuth flow:
// signIn(provider) → redirect → SITE_URL?code=… → exchange → JWT in localStorage → ConvexHttpClient.setAuth.
// Wavedash never calls this — host identity stays `wd:<id>` (see leaderboard.ts).
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

const JWT_KEY = "__convexAuthJWT";
const REFRESH_KEY = "__convexAuthRefreshToken";
const VERIFIER_KEY = "__convexAuthOAuthVerifier";

function ns(convexUrl: string) {
  return convexUrl.replace(/[^a-zA-Z0-9]/g, "");
}
function key(convexUrl: string, base: string) {
  return `${base}_${ns(convexUrl)}`;
}

function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
function lsDel(k: string) {
  try {
    localStorage.removeItem(k);
  } catch {}
}

export type AuthProviderId = "google" | "github" | "twitter";

export type AuthProfile = {
  guestId: string;
  username: string;
  provider: string | null;
  needsUsernameConfirm: boolean;
  image: string | null;
  coins: number;
  unlocks: string[];
  linked: boolean;
};

/** OAuth only on the production hosts (SITE_URL = scrappy-yard.vercel.app). Localhost/previews: buttons greyed. */
const LIVE_HOSTS = new Set(["scrappy-yard.vercel.app", "scrapyard-dash.vercel.app"]);
export function authLive(): boolean {
  if (import.meta.env.DEV) return false;
  try {
    return LIVE_HOSTS.has(location.hostname);
  } catch {
    return false;
  }
}

/** First-link guest → auth merge (server enforces once). */
export async function linkGuestProgress(guestId: string, guestName: string, localUnlocks: string[]) {
  if (!client || !profile || profile.linked) return;
  try {
    await client.mutation(api.profile.linkGuest, { guestId, guestName, localUnlocks });
  } catch (e) {
    console.warn("[auth] guest link failed", e);
  }
  await refreshProfile();
}

let client: ConvexHttpClient | null = null;
let convexUrl = "";
let profile: AuthProfile | null = null;
let ready = false;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function onAuthChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAuthProfile() {
  return profile;
}

export function isAuthReady() {
  return ready;
}

function applyToken(token: string | null) {
  if (!client) return;
  if (token) client.setAuth(token);
  else client.clearAuth();
}

function storeTokens(tokens: { token: string; refreshToken: string } | null) {
  if (!convexUrl) return;
  if (!tokens) {
    lsDel(key(convexUrl, JWT_KEY));
    lsDel(key(convexUrl, REFRESH_KEY));
    applyToken(null);
    return;
  }
  lsSet(key(convexUrl, JWT_KEY), tokens.token);
  lsSet(key(convexUrl, REFRESH_KEY), tokens.refreshToken);
  applyToken(tokens.token);
}

async function refreshProfile() {
  if (!client) {
    profile = null;
    return;
  }
  try {
    profile = (await client.query(api.profile.me, {})) as AuthProfile | null;
  } catch {
    profile = null;
  }
}

/** Exchange OAuth `?code=` (and refresh tokens) via auth:signIn. */
async function verify(params: { code?: string; refreshToken?: string; verifier?: string }) {
  if (!client) return false;
  const result = (await client.action(api.auth.signIn, {
    params: params.code ? { code: params.code } : undefined,
    refreshToken: params.refreshToken,
    verifier: params.verifier,
  })) as { tokens?: { token: string; refreshToken: string } | null };
  storeTokens(result.tokens ?? null);
  return !!result.tokens;
}

/**
 * Boot auth on web (not Wavedash). Handles `?code=` return, restores JWT, loads profile.
 * Safe to call once; idempotent.
 */
export async function startAuth(http: ConvexHttpClient | null, url: string): Promise<AuthProfile | null> {
  client = http;
  convexUrl = url;
  if (!client || !url) {
    ready = true;
    emit();
    return null;
  }

  // Consume OAuth return code first.
  try {
    const u = new URL(location.href);
    const code = u.searchParams.get("code");
    if (code) {
      const verifier = lsGet(key(url, VERIFIER_KEY)) ?? undefined;
      lsDel(key(url, VERIFIER_KEY));
      u.searchParams.delete("code");
      history.replaceState({}, "", u.pathname + u.search + u.hash);
      await verify({ code, verifier });
    } else {
      const token = lsGet(key(url, JWT_KEY));
      if (token) applyToken(token);
      else {
        const refresh = lsGet(key(url, REFRESH_KEY));
        if (refresh) await verify({ refreshToken: refresh });
      }
    }
  } catch (e) {
    console.warn("[auth] boot failed", e);
    storeTokens(null);
  }

  await refreshProfile();
  ready = true;
  emit();
  return profile;
}

/** Begin OAuth redirect for Google / GitHub / X. Throws if provider env is missing on Convex. */
export async function signInWith(provider: AuthProviderId) {
  if (!authLive()) throw new Error("sign-in is live-only");
  if (!client) throw new Error("auth offline");
  const result = (await client.action(api.auth.signIn, { provider })) as {
    redirect?: string;
    verifier?: string;
    tokens?: { token: string; refreshToken: string } | null;
  };
  if (result.redirect) {
    if (result.verifier) lsSet(key(convexUrl, VERIFIER_KEY), result.verifier);
    location.href = result.redirect;
    return;
  }
  if (result.tokens) {
    storeTokens(result.tokens);
    await refreshProfile();
    emit();
  }
}

export async function signOutAuth() {
  if (client) {
    try {
      await client.action(api.auth.signOut, {});
    } catch {
      /* already signed out */
    }
  }
  storeTokens(null);
  profile = null;
  emit();
}

export async function confirmAuthUsername(username: string) {
  if (!client) throw new Error("auth offline");
  const r = await client.mutation(api.profile.confirmUsername, { username });
  await refreshProfile();
  emit();
  return r;
}

export async function setAuthUsername(username: string) {
  if (!client) throw new Error("auth offline");
  const r = await client.mutation(api.profile.setUsername, { username });
  await refreshProfile();
  emit();
  return r;
}
