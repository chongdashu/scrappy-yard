// Scrappy Yard title + main menu skin: the engine's screens (index.html #boot, #menu) re-dressed as a
// junkyard game menu — stamped wordmark, hazard tape, steel plate buttons. Runs once at import
// (before the engine fills [data-game-title]), so the first painted frame is already skinned.
// Styles live in style.css under `body.sd`.
//
// Customise opens a character-preview mode (body.sd-customise): camera zooms on the player,
// menu chrome hides, overlay lets the player browse / select / buy skins. Menu order is
// Play → Customise (green plate) → Options.

import { platform } from "@engine/platform";
import {
  closeCustomise,
  customiseLoadingLabel,
  customisePreviewId,
  isCustomiseLoading,
  isCustomiseOpen,
  openCustomise,
  setCustomisePreview,
} from "./customise";
import { icon } from "./icons";
import { installLeaderboard } from "./leaderboard";
import { customiseCtaState } from "./customise-cta";
import { currentSkin, isOwned, lastPurchaseFailure, needsSignInToBuy, purchaseSkin, setSkin, SKINS, skinChipLabel } from "./iap";

const WORDMARK = `<span class="sd-w1">Scrappy</span><span class="sd-w2">Yard</span>`;
const TAPE = `<div class="sd-tape top" aria-hidden="true"></div><div class="sd-tape bottom" aria-hidden="true"></div>`;

let skinBtn: HTMLButtonElement | null = null;
let browseIdx = 0;
let panel: HTMLElement | null = null;
let nameEl: HTMLElement | null = null;
let bioEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let ctaBtn: HTMLButtonElement | null = null;
let busy = false;

export function paintSkinChip() {
  if (!skinBtn) return;
  // Plate subtitle always reflects the selected owned skin (not a locked browse).
  const cur = currentSkin();
  const { title, locked } = skinChipLabel(cur);
  setSub(title);
  skinBtn.classList.toggle("locked", locked);
  skinBtn.title = "Preview and pick a runner";
  skinBtn.setAttribute("aria-label", `Customise — ${title}`);
}

function setSub(text: string) {
  const sub = skinBtn?.querySelector<HTMLElement>(".sd-sub");
  if (sub) sub.textContent = text;
}

function shownSkin() {
  return SKINS[browseIdx] ?? currentSkin();
}

function applyCta(s: (typeof SKINS)[number], loading: boolean) {
  if (!ctaBtn) return;
  const cta = customiseCtaState(s, {
    owned: isOwned(s),
    selected: currentSkin().id === s.id,
    needsSignIn: needsSignInToBuy(),
    loading,
    busy,
    loadingLabel: customiseLoadingLabel() || undefined,
  });
  ctaBtn.disabled = cta.disabled;
  ctaBtn.classList.toggle("locked", cta.locked);
  ctaBtn.textContent = cta.label;
  ctaBtn.dataset.mode = cta.mode;
}

function paintPanel() {
  if (!panel) return;
  const s = shownSkin();
  const loading = isCustomiseLoading();
  if (nameEl) nameEl.textContent = s.name;
  if (bioEl) bioEl.textContent = s.bio;
  if (statusEl) {
    statusEl.hidden = !loading;
    statusEl.textContent = loading ? customiseLoadingLabel() || "Loading…" : "";
  }
  panel.classList.toggle("is-loading", loading);
  for (const nav of panel.querySelectorAll<HTMLButtonElement>("[data-nav]")) {
    nav.disabled = loading || busy;
  }
  applyCta(s, loading);
  // Keep 3D in sync with the browse cursor (gym hides the old mesh while loading).
  setCustomisePreview(s.id);
}

function cycle(delta: number) {
  if (!SKINS.length || isCustomiseLoading() || busy) return;
  browseIdx = (browseIdx + delta + SKINS.length) % SKINS.length;
  paintPanel();
}

async function onCta() {
  if (busy || isCustomiseLoading() || !ctaBtn) return;
  const s = shownSkin();
  const mode = ctaBtn.dataset.mode;
  if (mode === "selected" || mode === "loading") return;
  if (mode === "select") {
    setSkin(s.id);
    setCustomisePreview(s.id);
    paintSkinChip();
    paintPanel();
    return;
  }
  if (mode === "signin" || (mode === "buy" && needsSignInToBuy())) {
    promptSignIn();
    return;
  }
  if (mode === "buy" && s.sku) {
    busy = true;
    ctaBtn.textContent = "Opening checkout…";
    ctaBtn.disabled = true;
    const ok = await purchaseSkin(s.sku);
    busy = false;
    paintPanel();
    paintSkinChip();
    if (!ok && lastPurchaseFailure() === "signin") {
      promptSignIn();
    } else if (!ok && ctaBtn) {
      ctaBtn.textContent = "Checkout unavailable — try later";
      setTimeout(() => paintPanel(), 1400);
    }
  }
}

/** Soft nudge to the Google/GitHub row (CTA already says Sign in to unlock skins and is disabled). */
function promptSignIn() {
  leaveCustomise(false);
  const bar = document.querySelector<HTMLElement>(".sd-auth");
  if (!bar) return;
  bar.querySelector(".sd-auth-prompt")?.remove();
  bar.classList.remove("sd-auth-pulse");
  void bar.offsetWidth;
  bar.classList.add("sd-auth-pulse");
  bar.scrollIntoView({ block: "nearest", behavior: "smooth" });
  bar.querySelector<HTMLButtonElement>(".sd-auth-btn:not([disabled])")?.focus();
  setTimeout(() => bar.classList.remove("sd-auth-pulse"), 4000);
}

function leaveCustomise(commit: boolean) {
  if (!isCustomiseOpen()) return;
  if (!commit) {
    // Back without Select: restore the owned skin that was active when we opened.
    const owned = currentSkin().id;
    browseIdx = Math.max(0, SKINS.findIndex((s) => s.id === owned));
    setCustomisePreview(owned);
  } else {
    // Keep whatever is now selected (Select / successful buy already called setSkin).
    setCustomisePreview(currentSkin().id);
  }
  closeCustomise();
  if (panel) panel.hidden = true;
  paintSkinChip();
}

function openPanel() {
  const owned = currentSkin();
  browseIdx = Math.max(0, SKINS.findIndex((s) => s.id === owned.id));
  openCustomise(owned.id, owned.id);
  if (panel) panel.hidden = false;
  paintPanel();
  // Focus primary action for keyboard users.
  ctaBtn?.focus();
}

function onKey(e: KeyboardEvent) {
  if (!isCustomiseOpen()) return;
  if (e.key === "Escape" || e.key === "Backspace") {
    e.preventDefault();
    e.stopPropagation();
    leaveCustomise(false);
    return;
  }
  if (isCustomiseLoading() || busy) return;
  if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
    e.preventDefault();
    e.stopPropagation();
    cycle(-1);
    return;
  }
  if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
    e.preventDefault();
    e.stopPropagation();
    cycle(1);
    return;
  }
}

function installCustomisePanel(menu: HTMLElement) {
  if (document.getElementById("sd-customise")) return;
  menu.insertAdjacentHTML(
    "beforeend",
    `<div id="sd-customise" class="sd-customise" hidden role="dialog" aria-modal="true" aria-labelledby="sd-customise-name">` +
      `<div class="sd-customise-chrome">` +
      `<button type="button" class="sd-customise-nav prev" data-nav="-1" aria-label="Previous skin"><span aria-hidden="true">‹</span></button>` +
      `<div class="sd-customise-card">` +
      `<p class="sd-customise-kicker">Customise</p>` +
      `<h2 id="sd-customise-name" class="sd-customise-name"></h2>` +
      `<p class="sd-customise-bio"></p>` +
      `<p class="sd-customise-status" hidden aria-live="polite"></p>` +
      `<div class="sd-customise-progress" aria-hidden="true"><i></i></div>` +
      `<button type="button" class="sd-customise-cta" data-cta></button>` +
      `</div>` +
      `<button type="button" class="sd-customise-nav next" data-nav="1" aria-label="Next skin"><span aria-hidden="true">›</span></button>` +
      `</div>` +
      `<button type="button" class="sd-customise-back" data-back>Back</button>` +
      `</div>`,
  );
  panel = document.getElementById("sd-customise");
  nameEl = panel?.querySelector(".sd-customise-name") ?? null;
  bioEl = panel?.querySelector(".sd-customise-bio") ?? null;
  statusEl = panel?.querySelector(".sd-customise-status") ?? null;
  ctaBtn = panel?.querySelector<HTMLButtonElement>("[data-cta]") ?? null;

  panel?.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-nav], [data-cta], [data-back]");
    if (!t || !panel?.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    if (t.hasAttribute("data-back")) leaveCustomise(false);
    else if (t.hasAttribute("data-cta")) void onCta();
    else if (t.hasAttribute("data-nav")) cycle(Number(t.getAttribute("data-nav") || 0));
  });

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("sd-entitlements", () => {
    paintSkinChip();
    if (isCustomiseOpen()) paintPanel();
  });
  // Gym reports loading via setCustomiseLoading → sd-customise; refresh chrome (no re-emit loop:
  // paintPanel only calls setCustomisePreview when the browse id actually changes).
  window.addEventListener("sd-customise", () => {
    if (!isCustomiseOpen() || !panel || panel.hidden) return;
    const loading = isCustomiseLoading();
    if (statusEl) {
      statusEl.hidden = !loading;
      statusEl.textContent = loading ? customiseLoadingLabel() || "Loading…" : "";
    }
    panel.classList.toggle("is-loading", loading);
    for (const nav of panel.querySelectorAll<HTMLButtonElement>("[data-nav]")) {
      nav.disabled = loading || busy;
    }
    if (!ctaBtn || busy) return;
    // Restore Select / Unlock / guest sign-in without re-firing setCustomisePreview.
    applyCta(shownSkin(), loading);
  });
}

/** Insert the green Customise plate immediately before Options (Play → Customise → Options). */
function installSkinChip(list: Element) {
  const html =
    `<button type="button" class="mbtn sd-plate sd-skin" data-act="skin" aria-label="Customise"><span class="sd-ico" aria-hidden="true">${icon("pencil")}</span><span class="sd-lbl">Customise</span><small class="sd-sub"></small></button>`;
  const settings = list.querySelector('[data-act="settings"]');
  if (settings) settings.insertAdjacentHTML("beforebegin", html);
  else list.insertAdjacentHTML("beforeend", html);
  skinBtn = list.querySelector<HTMLButtonElement>(".sd-skin");
  browseIdx = Math.max(0, SKINS.findIndex((s) => s.id === currentSkin().id));
  paintSkinChip();
  skinBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPanel();
  });
}

export function installMenuSkin() {
  if (typeof document === "undefined") return;
  document.body.classList.add("sd");
  for (const logo of document.querySelectorAll<HTMLElement>("#boot .logo, #menu .logo")) {
    logo.removeAttribute("data-game-title"); // our two-line stamped wordmark, not the plain build title
    logo.classList.add("sd-wordmark");
    logo.setAttribute("aria-label", "Scrappy Yard");
    logo.innerHTML = WORDMARK;
  }
  for (const id of ["boot", "menu"]) document.getElementById(id)?.insertAdjacentHTML("afterbegin", TAPE);

  const press = document.querySelector<HTMLElement>("#press-start");
  press?.classList.add("sd-plate");

  const menu = document.getElementById("menu");
  const list = menu?.querySelector(".menu-list");
  const label = (act: string, html: string) => {
    const b = list?.querySelector<HTMLElement>(`[data-act="${act}"]`);
    if (b) {
      b.innerHTML = html;
      b.classList.add("sd-plate");
    }
  };
  label("play", `<span class="sd-ico" aria-hidden="true">${icon("play")}</span><span class="sd-lbl">Play</span><small class="sd-sub">Start the run</small>`);
  // No "How to play" on the main menu or pause card (published build; GameModule.help === false also hides them).
  list?.querySelector('[data-act="help"]')?.remove();
  // Hide — do not remove. Flow binds $("#pause-help") at construct; a missing node throws and freezes splash on Ready.
  const pauseHelp = document.querySelector<HTMLElement>("#pause-help");
  if (pauseHelp) pauseHelp.hidden = true;
  // Customise above Options: insert before labeling settings so order is Play → Customise → Options.
  if (list) installSkinChip(list);
  label("settings", `<span class="sd-ico" aria-hidden="true">${icon("gear")}</span><span class="sd-lbl">Options</span>`);
  list?.insertAdjacentHTML("beforeend", `<i class="sd-break" aria-hidden="true"></i>`);

  // Under the wordmark: username + Convex/Wavedash leaderboard (leaderboard.ts) + web auth buttons.
  installLeaderboard();

  if (menu) installCustomisePanel(menu);

  const foot = menu?.querySelector(".menu-foot");
  // No outbound URL on a portal host (Wavedash): just the keys.
  const url = platform.id === "wavedash" ? "" : `<a class="sd-url sd-wd-link" href="https://wavedash.com/games/scrappy-yard" target="_blank" rel="noopener">▶ Play on Wavedash</a>`;
  if (foot) foot.innerHTML = `${url}<span class="sd-keys"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> go</span>`;
}

// Re-export for tests / hooks that painted the chip after a purchase.
export { paintPanel as paintCustomisePanel, leaveCustomise, isCustomiseOpen, customisePreviewId };
