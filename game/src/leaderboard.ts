// Scrappy Yard identity + Convex leaderboard (vanilla DOM over the engine's #menu).
//
// Identities (players.guestId) — parallel, never merged:
//   - Web guest: random UUID in localStorage (editable scrapyard name).
//   - Web signed-in (Convex Auth Google/GitHub/X): `auth:<convexUserId>`.
//   - Wavedash host: `wd:<wavedashUserId>` + read-only Wavedash username. No Convex OAuth on that host.
//
// Board: each identity's best run, distance desc then nuts (convex/leaderboard.ts `top`).
// On Wavedash the menu panel prefers the host board; Convex is the cross-host record.
// Auth UI (sign-in buttons, Google username modal) is web-only.
import { ConvexHttpClient } from "convex/browser";
import { platform, type BoardDef, type BoardEntry } from "@engine/platform";
import { api } from "../../convex/_generated/api";
import {
  confirmAuthUsername,
  authLive,
  getAuthProfile,
  linkGuestProgress,
  onAuthChange,
  setAuthUsername,
  signInWith,
  signOutAuth,
  startAuth,
  type AuthProviderId,
} from "./auth";
import { icon } from "./icons";
import { setOwnedSkus } from "./skins";
import { configureIap, refreshEntitlements, startIap } from "./iap";

/** The Wavedash leaderboard (created by the host on first use). Score = metres; metadata.nuts = nuts of that run. */
export const WAVEDASH_BOARD: BoardDef = { name: "distance", sort: "desc", display: "numeric" };
const onWavedash = platform.id === "wavedash";

const KEY_ID = "scrapyard.guestId";
const KEY_NAME = "scrapyard.guestName";
/** Local unlock flags (JSON SKU array) — merged into the auth profile on first link. */
const KEY_UNLOCKS = "scrapyard.unlocks";
const NAME_MAX = 16;
const NAME_MIN = 2;
const TOP_N = 8;

const A = ["Rusty", "Greasy", "Busted", "Dented", "Scrappy", "Turbo", "Sparky", "Rowdy", "Grimy", "Bent", "Lucky", "Wonky", "Crusty", "Nitro", "Junky", "Clanky"];
const B = ["Bolt", "Nut", "Gasket", "Piston", "Sprocket", "Muffler", "Wrench", "Hubcap", "Crank", "Axle", "Rivet", "Spring", "Valve", "Fender", "Raccoon", "Tinker"];
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
export const generateName = () => `${pick(A)}${pick(B)}${10 + Math.floor(Math.random() * 90)}`;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

/** Trim, collapse to [A-Za-z0-9_-], clamp length; null when too short to keep. */
export function cleanName(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "").slice(0, NAME_MAX);
  return s.length >= NAME_MIN ? s : null;
}

function guest() {
  let id = store.get(KEY_ID);
  if (!id || id.length < 8) {
    id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    store.set(KEY_ID, id);
  }
  let name = cleanName(store.get(KEY_NAME) ?? "");
  if (!name) {
    name = generateName();
    store.set(KEY_NAME, name);
  }
  return { id, name };
}

const URL_ = (import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "";
// Automated browsers (smoke, capture) stay off the network and never write to the real board; ?leaderboard opts back in.
const automated = typeof navigator !== "undefined" && navigator.webdriver && !(typeof location !== "undefined" && new URLSearchParams(location.search).has("leaderboard"));
const client = URL_ && !automated ? new ConvexHttpClient(URL_) : null;

/** Local anonymous guest — restored after sign-out. */
const localGuest = typeof localStorage !== "undefined" ? guest() : { id: "nobody00", name: "Guest" };
const me: { id: string; name: string; host: boolean; auth: boolean } = {
  id: localGuest.id,
  name: localGuest.name,
  host: false,
  auth: false,
};

/** On Wavedash, adopt the signed-in Wavedash user (id → Convex guestId `wd:<id>`, username → read-only name). */
function adoptHostIdentity(): boolean {
  if (!onWavedash) return false;
  let u: { id: string; username: string } | null = null;
  try {
    u = platform.lobbies?.getUser() ?? null;
  } catch {}
  if (!u?.id) return false;
  const name = cleanName(u.username) ?? me.name;
  me.id = `wd:${u.id}`.slice(0, 64);
  me.name = name;
  me.host = true;
  me.auth = false;
  return true;
}

/** Apply Convex Auth profile (web). Falls back to local guest when signed out. */
function adoptAuthIdentity() {
  if (onWavedash || me.host) return;
  const p = getAuthProfile();
  if (p) {
    me.id = p.guestId;
    me.name = p.username;
    me.auth = true;
  } else {
    me.id = localGuest.id;
    me.name = store.get(KEY_NAME) ?? localGuest.name;
    me.auth = false;
  }
}

type Row = { rank: number; username: string; distance: number; nuts: number; me: boolean };

/** Sort rows distance desc → nuts desc → incoming order, and reassign rank 1..n. Exported for tests. */
export function rankRows(rows: Row[]): Row[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.distance - a.r.distance || b.r.nuts - a.r.nuts || a.i - b.i)
    .map(({ r }, i) => ({ ...r, rank: i + 1 }));
}

/** Wavedash board entries → panel rows (nuts from metadata; missing → 0). Exported for tests. */
export function wavedashRows(top: BoardEntry[], around: BoardEntry[] | null): { entries: Row[]; me: Row | null } {
  const row = (e: BoardEntry): Row => ({ rank: e.rank, username: e.name, distance: Math.round(e.score), nuts: Math.round(Number(e.meta?.nuts) || 0), me: e.me });
  // Host board score is distance only, so host ranks ignore nuts. Re-rank client-side:
  // distance desc, then nuts desc, then host order (stable) — matches convex `top`.
  const entries = rankRows(top.map(row));
  const mine = entries.some((e) => e.me) ? null : (around?.find((e) => e.me) ?? null);
  return { entries, me: mine ? row(mine) : null };
}

async function wavedashBoard(): Promise<{ entries: Row[]; me: Row | null } | null> {
  const boards = platform.boards;
  if (!onWavedash || !me.host || !boards) return null;
  const top = await boards.top(WAVEDASH_BOARD, TOP_N);
  if (!top) return null;
  return wavedashRows(top, await boards.around(WAVEDASH_BOARD, 0, 0));
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let panel: HTMLElement | null = null;
let lbSlot: HTMLElement | null = null;
let lbSheet: HTMLElement | null = null;
let loading = false;
let started = false;
let authBar: HTMLElement | null = null;
let idStrip: HTMLElement | null = null;

let hostName: (() => void) | null = null;
let paintName: (() => void) | null = null;

async function refresh() {
  if (!panel || loading || !started) return;
  const body = panel.querySelector<HTMLElement>(".sd-lb-rows")!;
  loading = true;
  try {
    const board = (await wavedashBoard()) ?? (client ? await client.query(api.leaderboard.top, { limit: TOP_N, guestId: me.id }) : null);
    if (!board) throw new Error("no leaderboard");
    const { entries, me: mine } = board;
    const row = (e: { rank: number; username: string; distance: number; nuts: number }, isMe: boolean) =>
      `<li class="sd-lb-row${isMe ? " me" : ""}${e.rank <= 3 ? ` r${e.rank}` : ""}"><span class="sd-lb-rank">${e.rank}</span>` +
      `<span class="sd-lb-name">${esc(e.username)}</span><span class="sd-lb-dist">${e.distance}<small>m</small></span>` +
      `<span class="sd-lb-nuts">${e.nuts}<i class="sd-nut" aria-hidden="true"></i></span></li>`;
    body.innerHTML = entries.length
      ? entries.map((e) => row(e, e.me)).join("") + (mine ? `<li class="sd-lb-gap" aria-hidden="true">···</li>${row(mine, true)}` : "")
      : `<li class="sd-lb-empty">No runs yet. Be the first!</li>`;
  } catch {
    body.innerHTML = `<li class="sd-lb-empty">Leaderboard offline</li>`;
  } finally {
    loading = false;
  }
}

async function syncName() {
  if (!client) return;
  try {
    await client.mutation(api.leaderboard.ensurePlayer, { guestId: me.id, username: me.name });
  } catch {}
}

let submitting = false;
/**
 * One finished run (game over or finish). Guarded by the caller per round; fire-and-forget. Convex always (when configured); on Wavedash
 * also the host board (distance score, nuts metadata). The two writes are independent: one failing never blocks the other.
 */
export async function submitRun(distance: number, nuts: number, won: boolean) {
  if (submitting) return;
  if (!me.host) adoptHostIdentity(); // the SDK may have resolved after startLeaderboard
  submitting = true;
  const d = Math.max(0, Math.round(distance));
  const n = Math.max(0, Math.round(nuts));
  const writes: Promise<unknown>[] = [];
  if (client) writes.push(client.mutation(api.leaderboard.submitRun, { guestId: me.id, username: me.name, distance: d, nuts: n, won }));
  if (onWavedash && platform.boards && !automated) writes.push(platform.boards.submit(WAVEDASH_BOARD, d, { nuts: n, won }));
  try {
    const results = await Promise.allSettled(writes);
    for (const r of results) if (r.status === "rejected") console.warn("[leaderboard] submit failed", r.reason);
  } finally {
    submitting = false;
  }
  void refresh();
}

function providerLabel(id: string | null | undefined) {
  if (id === "google") return "Google";
  if (id === "github") return "GitHub";
  if (id === "twitter") return "X";
  return "Signed in";
}

/** Brand marks for the save-progress buttons (official-shape SVGs, inline so no extra requests). */
const BRAND: Record<"google" | "github" | "twitter", string> = {
  google:
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.56-5.17 3.56-8.8z"/>` +
    `<path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24z"/>` +
    `<path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.11z"/>` +
    `<path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77z"/>` +
    `</svg>`,
  github:
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57l-.02-2.04c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.6-2.67-.31-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.62-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .32.21.69.82.57A12 12 0 0 0 12 .3"/></svg>`,
  twitter:
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.63 7.58H.48l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.48 3.24H4.3l13.31 17.41z"/></svg>`,
};
/** Sign-in buttons shown in the auth strip. Twitter/X kept in BRAND + auth.ts; hidden for now (owner, 2026-11-05). */
const PROVIDERS: { id: keyof typeof BRAND; name: string }[] = [
  { id: "google", name: "Google" },
  { id: "github", name: "GitHub" },
];

/** Third-party OAuth (Google/GitHub) re-enabled (owner, 2026-11-05); X still hidden via PROVIDERS. */
const SHOW_OAUTH = true;
const WAVEDASH_URL = "https://wavedash.com/games/scrappy-yard";

function paintAuthBar() {
  if (!authBar || onWavedash) return;
  const p = getAuthProfile();
  if (p) {
    // Compact chip: provider + Saved + Sign out. Editable name lives in .sd-guest (no duplicate "Signed in as…").
    const prov = p.provider === "google" || p.provider === "github" || p.provider === "twitter" ? p.provider : null;
    authBar.classList.remove("offline");
    authBar.classList.add("signed-in");
    authBar.innerHTML =
      `<div class="sd-auth-chip" title="Signed in via ${esc(providerLabel(p.provider))} · progress saved">` +
      (prov ? `<span class="sd-auth-mark" data-p="${prov}">${BRAND[prov]}</span>` : `<i class="sd-auth-dot on" aria-hidden="true"></i>`) +
      `<span class="sd-auth-tag sd-auth-saved">Saved</span>` +
      `<button type="button" class="sd-auth-out" data-auth="out">Sign out</button>` +
      `</div>`;
  } else {
    const live = authLive();
    const dis = live ? "" : ` disabled aria-disabled="true"`;
    const tip = (n: string) => (live ? `Sign in with ${n} to save progress` : "Saving progress works on the live yard only");
    authBar.classList.remove("signed-in");
    authBar.classList.toggle("offline", !live);
    authBar.innerHTML =
      `<div class="sd-auth-status"><i class="sd-auth-dot" aria-hidden="true"></i>` +
      `<span class="sd-auth-line">Playing as <b>Guest</b></span>` +
      `<span class="sd-auth-via">this device only</span></div>` +
      (!SHOW_OAUTH
        ? `<div class="sd-auth-row"><a class="sd-auth-tag sd-wd-cta" href="${WAVEDASH_URL}" target="_blank" rel="noopener">Play on Wavedash · skins &amp; progress</a></div>`
        : `<div class="sd-auth-row"><span class="sd-auth-tag">Sign in to save</span>` +
      PROVIDERS.map(
        ({ id, name }) =>
          `<button type="button" class="sd-auth-btn" data-auth="${id}" title="${tip(name)}" aria-label="${tip(name)}"${dis}>${BRAND[id]}</button>`,
      ).join("") +
      (live ? "" : `<span class="sd-auth-hint">Live yard only</span>`) +
      `</div>`);
  }
}

function showUsernameModal(suggested: string) {
  if (document.getElementById("sd-name-modal")) return;
  const overlay = document.createElement("div");
  overlay.id = "sd-name-modal";
  overlay.className = "sd-modal";
  overlay.innerHTML =
    `<div class="sd-modal-card" role="dialog" aria-labelledby="sd-name-modal-title">` +
    `<div class="sd-tape top" aria-hidden="true"></div>` +
    `<h2 id="sd-name-modal-title" class="sd-modal-title">Pick your scrapyard name</h2>` +
    `<p class="sd-modal-copy">Google signed you in as <strong>${esc(suggested)}</strong>. Confirm or change it for the leaderboard.</p>` +
    `<label class="sd-modal-label">Username<input class="sd-modal-input" type="text" maxlength="${NAME_MAX}" value="${esc(suggested)}" spellcheck="false" autocomplete="off"/></label>` +
    `<p class="sd-modal-hint">Letters, numbers, _ and - · ${NAME_MIN}–${NAME_MAX} chars</p>` +
    `<p class="sd-modal-err" hidden></p>` +
    `<button type="button" class="sd-modal-go sd-plate">Confirm</button>` +
    `<div class="sd-tape bottom" aria-hidden="true"></div>` +
    `</div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector<HTMLInputElement>(".sd-modal-input")!;
  const err = overlay.querySelector<HTMLElement>(".sd-modal-err")!;
  const go = overlay.querySelector<HTMLButtonElement>(".sd-modal-go")!;
  const submit = async () => {
    const next = cleanName(input.value);
    if (!next) {
      err.hidden = false;
      err.textContent = "Name too short or invalid.";
      return;
    }
    go.disabled = true;
    try {
      await confirmAuthUsername(next);
      me.name = next;
      paintName?.();
      overlay.remove();
      void syncName().then(refresh);
    } catch (e) {
      err.hidden = false;
      err.textContent = e instanceof Error ? e.message : "Could not save.";
      go.disabled = false;
    }
  };
  go.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });
  input.focus();
  input.select();
}

function onAuthUiChange() {
  if (onWavedash) return;
  adoptAuthIdentity();
  setOwnedSkus(ownedSkus());
  void refreshEntitlements();
  paintAuthBar();
  paintName?.();
  const p = getAuthProfile();
  if (p?.needsUsernameConfirm) showUsernameModal(p.username);
  else document.getElementById("sd-name-modal")?.remove();
  if (started) void syncName().then(refresh);
}

function installAuthBar() {
  if (onWavedash) return;
  authBar = document.createElement("div");
  authBar.className = "sd-auth";
  authBar.setAttribute("aria-label", "Account");
  paintAuthBar();
  authBar.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-auth]");
    if (!t) return;
    const act = t.dataset.auth;
    if (act === "out") {
      void signOutAuth().then(() => {
        localGuest.name = store.get(KEY_NAME) ?? localGuest.name;
        onAuthUiChange();
      });
      return;
    }
    if ((act === "google" || act === "github" || act === "twitter") && authLive()) {
      t.setAttribute("disabled", "true");
      void signInWith(act as AuthProviderId).catch((err) => {
        console.warn("[auth] sign-in failed", err);
        t.removeAttribute("disabled");
        const msg = document.createElement("span");
        msg.className = "sd-auth-err";
        msg.textContent = "Sign-in not ready (OAuth keys missing)";
        authBar?.querySelector(".sd-auth-err")?.remove();
        authBar?.appendChild(msg);
      });
    }
  });
  onAuthChange(onAuthUiChange);
}

function installGuestName() {
  const wrap = document.createElement("div");
  wrap.className = "sd-guest";
  wrap.innerHTML =
    `<span class="sd-guest-tag">Username</span>` +
    `<button type="button" class="sd-guest-name" title="Click to rename"></button>` +
    `<button type="button" class="sd-guest-edit" aria-label="Edit name" title="Edit name">${icon("pencil")}</button>`;

  const nameBtn = wrap.querySelector<HTMLButtonElement>(".sd-guest-name")!;
  const editBtn = wrap.querySelector<HTMLButtonElement>(".sd-guest-edit")!;
  nameBtn.textContent = me.name;

  paintName = () => {
    nameBtn.textContent = me.name;
    if (me.host) {
      wrap.classList.add("host");
      wrap.classList.remove("authed");
      nameBtn.disabled = true;
      nameBtn.title = "Your Wavedash name";
      editBtn.hidden = true;
    } else if (me.auth) {
      wrap.classList.add("authed");
      wrap.classList.remove("host");
      nameBtn.disabled = false;
      nameBtn.title = "Click to rename";
      editBtn.hidden = false;
      const tag = wrap.querySelector(".sd-guest-tag");
      if (tag) tag.textContent = providerLabel(getAuthProfile()?.provider);
    } else {
      wrap.classList.remove("host", "authed");
      nameBtn.disabled = false;
      nameBtn.title = "Click to rename";
      editBtn.hidden = false;
      const tag = wrap.querySelector(".sd-guest-tag");
      if (tag) tag.textContent = "Username";
    }
  };

  hostName = () => {
    paintName?.();
  };

  let input: HTMLInputElement | null = null;
  const finish = (save: boolean) => {
    if (!input) return;
    const box = input;
    input = null;
    const next = save ? cleanName(box.value) : null;
    if (next && next !== me.name) {
      me.name = next;
      if (me.auth) {
        void setAuthUsername(next).then(() => { paintAuthBar(); return refresh(); }).catch(() => {});
      } else {
        store.set(KEY_NAME, next);
        localGuest.name = next;
        void syncName().then(refresh);
      }
    }
    nameBtn.textContent = me.name;
    box.replaceWith(nameBtn);
    wrap.classList.remove("editing");
    editBtn.innerHTML = icon("pencil");
    editBtn.setAttribute("aria-label", "Edit name");
    nameBtn.focus({ preventScroll: true });
  };
  const start = () => {
    if (input || me.host) return;
    if (getAuthProfile()?.needsUsernameConfirm) return;
    input = document.createElement("input");
    Object.assign(input, { type: "text", value: me.name, maxLength: NAME_MAX, spellcheck: false, autocomplete: "off", className: "sd-guest-input" });
    input.setAttribute("aria-label", "Your leaderboard name");
    input.setAttribute("enterkeyhint", "done");
    // Keep typing out of the engine's menu keys (W/S/arrows move the selection) and gameplay keys.
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    nameBtn.replaceWith(input);
    wrap.classList.add("editing");
    editBtn.innerHTML = icon("check");
    editBtn.setAttribute("aria-label", "Save name");
    input.focus();
    input.select();
  };
  nameBtn.addEventListener("click", start);
  // mousedown on ✔ would blur (= save) first; keep focus so the click decides.
  editBtn.addEventListener("pointerdown", (e) => {
    if (input) e.preventDefault();
  });
  editBtn.addEventListener("click", () => (input ? finish(true) : start()));
  if (!idStrip) return;
  idStrip.appendChild(wrap);
  if (authBar) idStrip.appendChild(authBar);
}

function closeLbSheet() {
  if (!panel || !lbSlot || !lbSheet || lbSheet.hidden) return;
  lbSlot.appendChild(panel);
  panel.classList.remove("in-sheet");
  lbSheet.hidden = true;
  lbSheet.classList.remove("open");
  document.body.classList.remove("sd-lb-sheet-open");
}

function openLbSheet() {
  if (!panel || !lbSheet) return;
  const body = lbSheet.querySelector(".sd-lb-sheet-body");
  if (!body) return;
  body.appendChild(panel);
  panel.classList.add("in-sheet");
  lbSheet.hidden = false;
  lbSheet.classList.add("open");
  document.body.classList.add("sd-lb-sheet-open");
  void refresh();
  lbSheet.querySelector<HTMLButtonElement>(".sd-lb-sheet-close")?.focus({ preventScroll: true });
}

function installPanel(menu: HTMLElement) {
  const col = menu.querySelector(".menu-col");
  const list = col?.querySelector(".menu-list");

  // Portrait / phones: compact button opens the board as a sheet (inline board eats the game view).
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "sd-lb-open";
  openBtn.setAttribute("aria-haspopup", "dialog");
  openBtn.setAttribute("aria-controls", "sd-lb-sheet");
  openBtn.innerHTML = `${icon("flag")}<span>Leaderboard</span>`;
  list?.insertAdjacentElement("beforebegin", openBtn);

  lbSlot = document.createElement("div");
  lbSlot.className = "sd-lb-slot";
  openBtn.insertAdjacentElement("afterend", lbSlot);

  panel = document.createElement("aside");
  panel.className = "sd-lb";
  panel.setAttribute("aria-label", "Leaderboard");
  panel.innerHTML =
    `<div class="sd-lb-head"><span class="sd-lb-title">Top Scrappers</span><span class="sd-lb-cols"><span>Dist</span><span>Nuts</span></span></div>` +
    `<ol class="sd-lb-rows"><li class="sd-lb-empty">Loading…</li></ol>`;
  // Desktop/wide: absolute beside the centred column. Portrait: parked in the slot until the sheet opens.
  lbSlot.appendChild(panel);

  lbSheet = document.createElement("div");
  lbSheet.id = "sd-lb-sheet";
  lbSheet.className = "sd-lb-sheet";
  lbSheet.hidden = true;
  lbSheet.innerHTML =
    `<div class="sd-lb-sheet-card" role="dialog" aria-modal="true" aria-label="Leaderboard">` +
    `<button type="button" class="sd-lb-sheet-close" aria-label="Close leaderboard">Close</button>` +
    `<div class="sd-lb-sheet-body"></div>` +
    `</div>`;
  document.body.appendChild(lbSheet);

  openBtn.addEventListener("click", () => openLbSheet());
  lbSheet.addEventListener("click", (e) => {
    if (e.target === lbSheet) closeLbSheet();
  });
  lbSheet.querySelector(".sd-lb-sheet-close")?.addEventListener("click", () => closeLbSheet());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lbSheet && !lbSheet.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeLbSheet();
    }
  });
}

export function installLeaderboard() {
  if (typeof document === "undefined") return;
  const menu = document.getElementById("menu");
  if (!menu) return;
  idStrip = document.createElement("div");
  idStrip.className = "sd-id";
  idStrip.setAttribute("aria-label", "Player identity");
  menu.querySelector(".logo")?.insertAdjacentElement("afterend", idStrip);
  installAuthBar();
  installGuestName();
  installPanel(menu);
  // Refresh whenever the menu is shown again (back from a run); close the mobile sheet if the menu hides.
  new MutationObserver(() => {
    if (menu.hidden) closeLbSheet();
    else void refresh();
  }).observe(menu, { attributes: true, attributeFilter: ["hidden"] });
}

/** After platform.init(): pick the identity (Wavedash / Convex Auth / web guest), register it, fill the board. Idempotent. */
export function startLeaderboard() {
  if (started || typeof document === "undefined") return;
  started = true;
  configureIap({
    client,
    playerId: () => me.id,
    onChange: () => {
      setOwnedSkus(ownedSkus());
      try {
        window.dispatchEvent(new Event("sd-entitlements"));
      } catch {}
    },
  });
  if (adoptHostIdentity()) {
    hostName?.();
    startIap();
    void syncName().then(refresh);
    return;
  }
  // Web: boot Convex Auth (handles ?code=), then guest or auth identity.
  void startAuth(client, URL_).then(async () => {
    const p0 = getAuthProfile();
    if (p0 && !p0.linked) {
      let localUnlocks: string[] = [];
      try {
        localUnlocks = JSON.parse(store.get(KEY_UNLOCKS) ?? "[]");
      } catch {}
      await linkGuestProgress(localGuest.id, store.get(KEY_NAME) ?? localGuest.name, Array.isArray(localUnlocks) ? localUnlocks : []);
    }
    adoptAuthIdentity();
    setOwnedSkus(ownedSkus());
    paintName?.();
    paintAuthBar();
    const p = getAuthProfile();
    if (p?.needsUsernameConfirm) showUsernameModal(p.username);
    startIap();
    void syncName().then(refresh);
  });
}

function readLocalUnlocks(): string[] {
  try {
    const raw = JSON.parse(store.get(KEY_UNLOCKS) ?? "[]");
    return Array.isArray(raw) ? raw.map(String).filter((s) => /^skin_[a-z]+$/.test(s)) : [];
  } catch {
    return [];
  }
}

/** Entitlements for the current identity: auth profile ∪ local scrapyard.unlocks. */
export function ownedSkus(): string[] {
  const fromAuth = getAuthProfile()?.unlocks ?? [];
  return Array.from(new Set([...fromAuth, ...readLocalUnlocks()]));
}

/** Current leaderboard / IAP identity key (guest UUID, auth:, or wd:). */
export function currentPlayerId(): string {
  return me.id;
}

export function getLeaderboardClient() {
  return client;
}
