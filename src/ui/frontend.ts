// Front-end shell: boot/loading → press to start (the audio unlock gesture)
// → main menu, plus popups (settings, help, pause, results). Screens and
// popups own focus; keyboard, mouse, touch and gamepad all drive the same
// focus cursor. Game-agnostic: menu buttons report `data-act` through
// `onAction`, popups report closes through `onPopupClosed`.
import { claimShown, EASE, hideEl, motion, showEl, squish, tween } from "./tween";

export interface UiSounds {
  hover(): void;
  press(): void;
  back(): void;
  whoosh(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

export class Frontend {
  private boot = $("#boot");
  private fill = $("#boot-fill");
  private label = $("#boot-label");
  private bar = $("#boot-bar");
  private tip = $("#boot-tip");
  private press = $<HTMLButtonElement>("#press-start");
  private menu = $("#menu");
  private wipe = $("#wipe");
  private sel = 0;
  private tipTimer = 0;
  private padPrev: boolean[] = [];
  private padRepeat = 0;
  private openPopup: HTMLElement | null = null;
  private opener: HTMLElement | null = null;
  /** The popup whose close animation is running (a popup opened meanwhile swaps with it). */
  private closing: { el: HTMLElement; t: number } | null = null;
  onAction: ((act: string, el: HTMLElement) => void) | null = null;
  onPopupClosed: ((el: HTMLElement) => void) | null = null;
  menuOpen = false;

  get popupOpen() {
    return this.openPopup !== null;
  }

  get currentPopup() {
    return this.openPopup;
  }

  constructor(private sfx: UiSounds, tips: string[] = []) {
    if (tips.length) {
      let t = 0;
      this.tip.textContent = tips[0];
      this.tipTimer = window.setInterval(() => {
        t = (t + 1) % tips.length;
        tween(this.tip, [{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: 700, fill: "none" });
        setTimeout(() => (this.tip.textContent = tips[t]), 300);
      }, 3600);
    }
    // Menu: hover moves the cursor, click activates (native buttons: Enter/Space work too).
    this.menu.addEventListener("pointerover", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".mbtn");
      const i = b ? this.items.indexOf(b) : -1;
      if (i >= 0) this.select(i, true);
    });
    this.menu.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".mbtn[data-act]");
      if (b && this.menuOpen && !this.openPopup) this.activate(b);
      // Scene / page links (menu.extra href): navigate in the same gesture as Play. Keeps other
      // query params (e.g. ?renderer=webgl2). Native <a> nav alone was easy to miss on remote play
      // when the link only changed ?scene and left you on the menu.
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.mbtn[href]");
      if (a && this.menuOpen && !this.openPopup) {
        e.preventDefault();
        this.sfx.press();
        const next = new URL(a.getAttribute("href") || a.href, location.href);
        const cur = new URL(location.href);
        for (const [k, v] of cur.searchParams) if (!next.searchParams.has(k)) next.searchParams.set(k, v);
        location.assign(next.href);
      }
    });
    // Close buttons inside popups (scoped to [data-close] buttons, not any descendant).
    document.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-close]");
      if (b && this.openPopup?.contains(b)) this.closePopup();
    });
    addEventListener("keydown", (e) => this.onKey(e));
    requestAnimationFrame(this.pollPad);
  }

  private get items(): HTMLElement[] {
    return [...this.menu.querySelectorAll<HTMLElement>(".mbtn")].filter((b) => !b.hidden);
  }

  // ---------------------------------------------------------------- boot

  setProgress(p: number, text?: string) {
    const k = Math.max(0, Math.min(1, p));
    this.fill.style.transform = `scaleX(${k.toFixed(3)})`;
    this.bar.setAttribute("aria-valuenow", String(Math.round(k * 100)));
    this.label.textContent = text ?? `Loading… ${Math.round(k * 100)}%`;
  }

  /**
   * Show the start button; resolves on the player's first press (pointer, key
   * or gamepad A). `unlock` runs inside that gesture (audio, fullscreen).
   * `covered` runs while the transition hides the screen (swap in the menu
   * there, so the reveal lands on it). `transition` "cut" (GameModule.startTransition)
   * hides the loading screen and runs `covered` at once, with no wipe.
   * `#boot` gets the class `is-ready` here, for a game's boot style.
   */
  waitForStart(unlock: () => void, covered?: () => void | Promise<void>, transition: "wipe" | "cut" = "wipe"): Promise<void> {
    this.setProgress(1, "Ready");
    this.boot.classList.add("is-ready");
    const touch = document.body.classList.contains("touch-controls"); // (Input.touchControls: a touch screen, or the dev Mobile view)
    // Any key starts too (except Tab, which keeps moving focus, and shortcuts with a modifier): say so, except on touch screens.
    this.press.querySelector("span")!.textContent = touch ? "Tap to start" : "Click or press any key to start";
    this.bar.hidden = true;
    this.label.hidden = true;
    this.press.hidden = false;
    tween(this.press, [{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 420, easing: EASE.outBack, fill: "none" });
    this.press.focus({ preventScroll: true });
    return new Promise((resolve) => {
      let done = false;
      const go = (e: Event) => {
        if (done || this.press.hidden) return;
        if (e instanceof KeyboardEvent && (e.metaKey || e.ctrlKey || e.altKey || e.key === "Tab")) return;
        done = true;
        e.preventDefault();
        unlock();
        this.sfx.press();
        squish(this.press);
        removeEventListener("keydown", go);
        this.boot.removeEventListener("click", go);
        const swap = async () => {
          clearInterval(this.tipTimer);
          this.boot.hidden = true;
          await covered?.();
        };
        if (transition === "cut") void swap().then(() => resolve());
        else {
          const r = this.press.getBoundingClientRect();
          void this.transition(r.left + r.width / 2, r.top + r.height / 2, swap).then(() => resolve());
        }
      };
      addEventListener("keydown", go);
      // click, not pointerdown: on touch screens only the end of a tap is a user
      // activation, and audio can't start without one. Gamepad A and assistive
      // tech click the button, which bubbles here too.
      this.boot.addEventListener("click", go);
    });
  }

  /**
   * GameModule.wipeStyle: "circle" (the default disc) or "shutter" (two doors slam shut and part). Set it before the first
   * transition; "shutter" adds the two `.wipe-door` children to #wipe.
   */
  setWipeStyle(style: "circle" | "shutter" = "circle") {
    this.wipeStyle = style;
    this.wipe.classList.toggle("shutter", style === "shutter");
    if (style === "shutter" && !this.wipe.querySelector(".wipe-door")) {
      this.wipe.innerHTML = `<div class="wipe-door top"></div><div class="wipe-door bottom"></div>`;
    }
  }
  private wipeStyle: "circle" | "shutter" = "circle";

  /** Shutter wipe: the doors slam in from top and bottom, hold a beat with a jolt, run `mid`, then part. */
  private async shutter(mid?: () => void | Promise<void>) {
    const doors = [...this.wipe.querySelectorAll<HTMLElement>(".wipe-door")];
    const quick = motion.reduced;
    this.wipe.hidden = false;
    const slam = (d: HTMLElement, from: string) =>
      d.animate([{ transform: `translateY(${from})` }, { transform: "translateY(0)" }], { duration: quick ? 1 : 190, easing: "cubic-bezier(0.55, 0, 1, 0.45)", fill: "forwards" }).finished;
    await Promise.all([slam(doors[0], "-101%"), slam(doors[1], "101%")]);
    if (!quick) {
      await this.wipe.animate([{ transform: "translateY(0)" }, { transform: "translateY(5px)" }, { transform: "translateY(-2px)" }, { transform: "translateY(0)" }], { duration: 150, easing: "ease-out" }).finished;
    }
    await mid?.();
    if (!quick) await new Promise((r) => setTimeout(r, 70));
    const part = (d: HTMLElement, to: string) =>
      d.animate([{ transform: "translateY(0)" }, { transform: `translateY(${to})` }], { duration: quick ? 1 : 260, easing: "cubic-bezier(0.3, 0, 0.2, 1)", fill: "forwards" }).finished;
    await Promise.all([part(doors[0], "-101%"), part(doors[1], "101%")]);
    for (const d of doors) d.getAnimations().forEach((a) => a.cancel());
    this.wipe.hidden = true;
  }

  /** Screen wipe (circular, or the shutter from setWipeStyle) that covers the screen, runs `mid`, then reveals. */
  async transition(x = innerWidth / 2, y = innerHeight / 2, mid?: () => void | Promise<void>) {
    this.sfx.whoosh();
    if (this.wipeStyle === "shutter" && this.wipe.querySelector(".wipe-door")) return this.shutter(mid);
    this.wipe.hidden = false;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const quick = motion.reduced;
    await this.wipe.animate([{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${r}px at ${x}px ${y}px)` }], { duration: quick ? 1 : 380, easing: EASE.inOut, fill: "forwards" }).finished;
    await mid?.();
    await this.wipe.animate([{ opacity: 1 }, { opacity: 0 }], { duration: quick ? 1 : 320, easing: "ease-out", fill: "forwards" }).finished;
    this.wipe.getAnimations().forEach((a) => a.cancel());
    this.wipe.hidden = true;
  }

  // ---------------------------------------------------------------- menu

  /**
   * Show the main menu: it fades in with its logo dropping and its entries cascading (`fade`), or with `fade` false it is a hard
   * cut: logo and entries are all there on the first frame (the cut start from the title, GameModule.startTransition "cut").
   */
  showMenu(fade = true) {
    this.menuOpen = true;
    showEl(this.menu, fade ? { opacity: 0 } : null, fade);
    const logo = this.menu.querySelector(".logo");
    if (logo && fade) tween(logo, [{ transform: "translateY(-16px) scale(0.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 520, easing: EASE.outBack });
    const items = this.items;
    this.select(Math.max(0, items.findIndex((b) => b.classList.contains("primary"))), false);
  }

  hideMenu(): Promise<void> {
    this.menuOpen = false;
    return hideEl(this.menu, { opacity: 0 });
  }

  private select(i: number, sound: boolean) {
    const items = this.items;
    if (!items.length) return;
    const n = (i + items.length) % items.length;
    if (sound && n !== this.sel) this.sfx.hover();
    this.sel = n;
    items.forEach((b, k) => b.classList.toggle("sel", k === n));
    items[n].focus({ preventScroll: true });
  }

  private activate(b: HTMLElement) {
    this.sfx.press();
    squish(b);
    this.onAction?.(b.dataset.act ?? "", b);
  }

  // ---------------------------------------------------------------- keys + gamepad

  private onKey(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const pop = this.openPopup;
    if (pop) {
      if (e.code === "Escape" || e.code === "Backspace") {
        if ((e.target as HTMLElement)?.tagName === "INPUT" && e.code === "Backspace") return;
        e.preventDefault();
        this.closePopup();
        return;
      }
      if (e.code === "Tab" || e.code === "ArrowDown" || e.code === "ArrowUp") {
        e.preventDefault();
        this.moveFocus(pop, e.code === "ArrowUp" || (e.code === "Tab" && e.shiftKey) ? -1 : 1);
      }
      return;
    }
    if (!this.menuOpen) return;
    if (e.code === "ArrowDown" || e.code === "KeyS" || e.code === "ArrowRight") {
      e.preventDefault();
      this.select(this.sel + 1, true);
    } else if (e.code === "ArrowUp" || e.code === "KeyW" || e.code === "ArrowLeft") {
      e.preventDefault();
      this.select(this.sel - 1, true);
    } else if (e.code === "Tab") {
      e.preventDefault();
      this.select(this.sel + (e.shiftKey ? -1 : 1), true);
    }
  }

  /** Move focus within a popup (focus containment for Tab, arrows and the d-pad). */
  private moveFocus(root: HTMLElement, dir: number) {
    const list = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && el.offsetParent !== null);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = list[(i + dir + list.length) % list.length];
    next.focus({ preventScroll: false });
    this.sfx.hover();
  }

  private pollPad = () => {
    requestAnimationFrame(this.pollPad);
    const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
    if (!pad) return;
    const b = pad.buttons.map((x) => x.pressed);
    const edge = (i: number) => b[i] && !this.padPrev[i];
    // (Left/right step through the menu too: a game may lay its entries out in a row.)
    const up = b[12] || (pad.axes[1] ?? 0) < -0.6 || (this.menuOpen && !this.openPopup && (b[14] || (pad.axes[0] ?? 0) < -0.6));
    const down = b[13] || (pad.axes[1] ?? 0) > 0.6 || (this.menuOpen && !this.openPopup && (b[15] || (pad.axes[0] ?? 0) > 0.6));
    const now = performance.now();
    if ((up || down) && now > this.padRepeat) {
      this.padRepeat = now + 220;
      if (this.openPopup) this.moveFocus(this.openPopup, down ? 1 : -1);
      else if (this.menuOpen) this.select(this.sel + (down ? 1 : -1), true);
    }
    if (edge(0)) {
      // A presses the focused button (in a popup, the menu or the start screen); it never closes.
      const focused = document.activeElement as HTMLElement | null;
      const scope = this.openPopup ?? (this.menuOpen ? this.menu : !this.boot.hidden ? this.boot : null);
      if (scope && focused && scope.contains(focused) && (focused.tagName === "BUTTON" || focused.tagName === "A")) focused.click();
    }
    if (edge(1) && this.openPopup) this.closePopup();
    this.padPrev = b;
  };

  // ---------------------------------------------------------------- popups

  /** Open a popup (`.popup` with a `.pcard`). Focus lands on `[data-autofocus]`, else the first control. */
  openPopupEl(el: HTMLElement, opener: HTMLElement | null = document.activeElement as HTMLElement | null) {
    const c = this.closing;
    const prev = c && c.el !== el && !c.el.hidden && performance.now() - c.t < 400 ? c.el : null;
    this.closing = null;
    this.openPopup = el;
    this.opener = opener;
    if (prev) return this.swapPopup(prev, el);
    showEl(el, { opacity: 0 });
    this.popCard(el);
  }

  private popCard(el: HTMLElement) {
    const card = el.querySelector(".pcard");
    if (card) tween(card, [{ transform: "translateY(32px) scale(0.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, easing: EASE.outBack });
    if (!el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus({ preventScroll: true });
    }
  }

  /**
   * Popup → popup (pause → settings and back): the backdrop stays solid, the
   * old card drops out first, then the new one pops in, so the two never
   * animate over each other. The new popup is live at once (focus can land).
   */
  private swapPopup(prev: HTMLElement, el: HTMLElement) {
    claimShown(prev);
    prev.inert = true;
    tween(prev, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 });
    claimShown(el);
    el.hidden = false;
    el.inert = false;
    el.style.background = "transparent";
    const card = el.querySelector<HTMLElement>(".pcard");
    if (card) tween(card, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
    const prevCard = prev.querySelector(".pcard");
    const drop = prevCard ? tween(prevCard, [{ transform: "none", opacity: 1 }, { transform: "translateY(24px) scale(0.92)", opacity: 0 }], { duration: 160, easing: EASE.inQuad }).finished : Promise.resolve();
    void drop.catch(() => undefined).then(() => {
      prev.hidden = true;
      el.style.background = "";
      if (this.openPopup !== el) return; // closed or replaced meanwhile
      showEl(el, { opacity: 1 });
      this.popCard(el);
    });
  }

  closePopup(silent = false) {
    const el = this.openPopup;
    if (!el) return;
    if (!silent) this.sfx.back();
    this.openPopup = null;
    const closing = (this.closing = { el, t: performance.now() });
    void hideEl(el, { opacity: 0 }).then(() => {
      if (this.closing === closing) this.closing = null;
    });
    const opener = this.opener;
    this.opener = null;
    this.onPopupClosed?.(el);
    // The callback may have opened the next popup; otherwise focus returns to the opener.
    if (!this.openPopup) {
      if (this.menuOpen) this.select(this.sel, false);
      else if (opener?.isConnected && !opener.closest("[hidden]")) opener.focus({ preventScroll: true });
    }
  }
}
