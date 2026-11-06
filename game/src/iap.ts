// Host payments adapter: Wavedash → platform.paid; web/Vercel → Dodo via Convex action.
// Never fulfill from the return URL alone — webhook grants; ?unlock= only refreshes UI.
import { ConvexHttpClient } from "convex/browser";
import { platform } from "@engine/platform";
import { api } from "../../convex/_generated/api";
import { getAuthProfile } from "./auth";
import { purchaseGate } from "./purchase-gate";
import { currentSkin, isOwned, setOwnedSkus, setSkin, skinBySku, SKINS, type Skin } from "./skins";

const KEY_UNLOCKS = "scrapyard.unlocks";
const KEY_ID = "scrapyard.guestId";

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

function readLocalUnlocks(): string[] {
  try {
    const raw = JSON.parse(lsGet(KEY_UNLOCKS) ?? "[]");
    return Array.isArray(raw) ? raw.map(String).filter((s) => /^skin_[a-z]+$/.test(s)) : [];
  } catch {
    return [];
  }
}

export function persistLocalUnlock(sku: string) {
  if (!/^skin_[a-z]+$/.test(sku)) return;
  const next = Array.from(new Set([...readLocalUnlocks(), sku]));
  lsSet(KEY_UNLOCKS, JSON.stringify(next));
}

let client: ConvexHttpClient | null = null;
let playerIdFn: () => string = () => lsGet(KEY_ID) ?? "";
let onEntitlements: (() => void) | null = null;
let started = false;

export function configureIap(opts: {
  client: ConvexHttpClient | null;
  playerId: () => string;
  onChange?: () => void;
}) {
  client = opts.client;
  playerIdFn = opts.playerId;
  onEntitlements = opts.onChange ?? null;
}

function applyOwned(skus: string[]) {
  const merged = Array.from(new Set([...readLocalUnlocks(), ...skus]));
  setOwnedSkus(merged);
  onEntitlements?.();
}

/** Merge server wallet + Wavedash paid + local flags into setOwnedSkus. */
export async function refreshEntitlements(): Promise<string[]> {
  const local = readLocalUnlocks();
  let server: string[] = [];
  const id = playerIdFn();
  if (client && id.length >= 8) {
    try {
      const w = await client.query(api.leaderboard.wallet, { guestId: id });
      server = w.unlocks ?? [];
      for (const s of server) persistLocalUnlock(s);
    } catch (e) {
      console.warn("[iap] wallet refresh failed", e);
    }
  }
  if (platform.id === "wavedash" && platform.paid) {
    try {
      const set = await platform.paid.refresh();
      if (set) {
        for (const s of set) {
          if (/^skin_[a-z]+$/.test(s)) persistLocalUnlock(s);
        }
      }
    } catch (e) {
      console.warn("[iap] wavedash refresh failed", e);
    }
  }
  const merged = Array.from(new Set([...local, ...server, ...readLocalUnlocks()]));
  applyOwned(merged);
  return merged;
}

export type PurchaseResult = "ok" | "signin" | "unavailable";

/** Web guests can't buy — they must sign in first. Wavedash defers to the host. */
export function needsSignInToBuy(): boolean {
  return purchaseGate(platform.id, !!getAuthProfile()) === "signin";
}

let lastPurchaseResult: PurchaseResult = "ok";
export function lastPurchaseFailure(): PurchaseResult {
  return lastPurchaseResult;
}

export async function purchaseSkin(sku: string): Promise<boolean> {
  lastPurchaseResult = "unavailable";
  const ok = await purchaseSkinInner(sku);
  if (ok) lastPurchaseResult = "ok";
  return ok;
}

async function purchaseSkinInner(sku: string): Promise<boolean> {
  if (!/^skin_[a-z]+$/.test(sku)) return false;
  const skin = skinBySku(sku);
  if (skin && isOwned(skin)) return true;

  // Wavedash portal IAP
  if (platform.id === "wavedash" && platform.paid) {
    try {
      const ok = await platform.paid.purchase(sku);
      if (ok) {
        persistLocalUnlock(sku);
        await refreshEntitlements();
        if (skin) setSkin(skin.id);
        return true;
      }
    } catch (e) {
      console.warn("[iap] wavedash purchase failed", e);
    }
    return false;
  }

  // Web → Dodo checkout (Convex holds DODO_PAYMENTS_API_KEY). Guests must sign in first.
  if (needsSignInToBuy()) {
    lastPurchaseResult = "signin";
    return false;
  }
  if (!client) {
    console.warn("[iap] Convex client missing — cannot start checkout");
    return false;
  }
  const playerId = playerIdFn();
  if (playerId.length < 8) {
    console.warn("[iap] no player id");
    return false;
  }
  let origin = "https://scrappy-yard.vercel.app";
  try {
    origin = location.origin;
  } catch {}
  try {
    const session = await client.action(api.dodo.createSkinCheckout, {
      sku,
      playerId,
      origin,
    });
    if (session?.checkout_url) {
      location.assign(session.checkout_url);
      return true; // navigating away
    }
  } catch (e) {
    console.warn("[iap] checkout failed", e);
  }
  return false;
}

/** After Dodo return (?unlock=sku): refresh only — webhook is source of truth. */
async function handleUnlockReturn() {
  let sku: string | null = null;
  try {
    const u = new URL(location.href);
    sku = u.searchParams.get("unlock");
    if (!sku) return;
    u.searchParams.delete("unlock");
    history.replaceState({}, "", u.pathname + u.search + u.hash);
  } catch {
    return;
  }
  // Poll wallet a few times — webhook may land just after redirect.
  for (let i = 0; i < 6; i++) {
    await refreshEntitlements();
    const s = skinBySku(sku);
    if (s && isOwned(s)) {
      setSkin(s.id);
      onEntitlements?.();
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  onEntitlements?.();
}

export function startIap() {
  if (started || typeof document === "undefined") return;
  started = true;
  if (platform.id === "wavedash" && platform.paid) {
    platform.paid.onGranted((ids) => {
      for (const id of ids) {
        if (/^skin_[a-z]+$/.test(id)) persistLocalUnlock(id);
      }
      void refreshEntitlements();
    });
  }
  void refreshEntitlements().then(() => {
    void handleUnlockReturn();
  });
}

export function skinChipLabel(skin: Skin = currentSkin()): { title: string; locked: boolean } {
  if (isOwned(skin)) return { title: `Skin: ${skin.name}`, locked: false };
  const price = skin.priceUsd.toFixed(2);
  return { title: `Unlock ${skin.name} · $${price}`, locked: true };
}

export { SKINS, isOwned, currentSkin, setSkin };
