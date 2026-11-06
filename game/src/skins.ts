// Player skins — Tripo biped GLBs normalised by assets/scripts/normalize_char_skin.py
// (same clips as the raccoon). Entitlements: free raccoon + DodoPayments (web) /
// Wavedash platform.paid (portal). Keep UNLOCK_ALL false in published builds.

export interface Skin {
  id: string;
  key: string;
  name: string;
  bio: string;
  /** null = free; otherwise the store SKU to unlock. */
  sku: string | null;
  priceUsd: number;
}

export const SKINS: Skin[] = [
  { id: "char_raccoon_player", key: "raccoon", name: "Scrappy Raccoon", bio: "The original yard runner.", sku: null, priceUsd: 0 },
  { id: "char_fox_player", key: "fox", name: "Scrap Fox", bio: "Copper-furred mechanic who can fix anything with a wrench and a grin.", sku: "skin_fox", priceUsd: 1.99 },
  { id: "char_cat_player", key: "cat", name: "Alley Cat", bio: "Scrappy tabby in a torn vest; lands on her feet every time.", sku: "skin_cat", priceUsd: 1.99 },
  { id: "char_badger_player", key: "badger", name: "Bandit Badger", bio: "Hard-knuckle hauler in a hazard bandana; nothing blocks his lane.", sku: "skin_badger", priceUsd: 1.99 },
  { id: "char_possum_player", key: "possum", name: "Yard Possum", bio: "Lanky welder with a belt full of gadgets and a tail full of tricks.", sku: "skin_possum", priceUsd: 1.99 },
  { id: "char_otter_player", key: "otter", name: "Junk Otter", bio: "Oil-stained scarf, yellow rubber boots, always splashing through.", sku: "skin_otter", priceUsd: 1.99 },
];

const LS = "scrappy.skin";
/** Never flip in published builds — entitlements come from IAP / local unlocks. */
const UNLOCK_ALL = false;

/** Entitlements from Convex wallet/profile + local scrapyard.unlocks + Wavedash paid. */
let owned = new Set<string>();
export function setOwnedSkus(skus: string[]) {
  owned = new Set(skus);
}

export function ownedSkuList(): string[] {
  return Array.from(owned);
}

function find(v: string | null | undefined): Skin | undefined {
  if (!v) return undefined;
  return SKINS.find((s) => s.id === v || s.key === v || s.sku === v);
}

export function isOwned(skin: Skin): boolean {
  return skin.sku === null || UNLOCK_ALL || owned.has(skin.sku);
}

/** Selected skin: `?skin=` (DEV any / prod if owned) → localStorage if owned → raccoon. */
export function currentSkin(): Skin {
  let q: string | null = null;
  try {
    q = new URLSearchParams(location.search).get("skin");
  } catch {
    /* no location */
  }
  const fromQuery = find(q);
  if (fromQuery) {
    if (import.meta.env.DEV || isOwned(fromQuery)) return fromQuery;
  }
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LS);
  } catch {
    /* storage blocked */
  }
  const fromLs = find(stored);
  if (fromLs && isOwned(fromLs)) return fromLs;
  return SKINS[0];
}

/** Persist selection when owned (prod + DEV). */
export function setSkin(id: string) {
  const s = find(id);
  if (!s || !isOwned(s)) return;
  try {
    localStorage.setItem(LS, s.id);
  } catch {
    /* storage blocked */
  }
}

/** Next owned skin after the current selection. */
export function nextSkin(): Skin {
  const i = SKINS.findIndex((s) => s.id === currentSkin().id);
  for (let n = 1; n <= SKINS.length; n++) {
    const s = SKINS[(i + n) % SKINS.length];
    if (isOwned(s)) return s;
  }
  return SKINS[0];
}

export function skinBySku(sku: string): Skin | undefined {
  return SKINS.find((s) => s.sku === sku);
}
