#!/usr/bin/env node
// Browser smoke check of the active game's PRODUCTION package, served under a nested URL
// prefix the way hosts serve it (scripts/serve-release.mjs), in muted headless Chrome driven
// with trusted CDP input (no puppeteer, no injected state).
//
//   npm run smoke                                   package (web) → serve → desktop + phone
//   node tests/smoke.mjs --no-package               reuse release/web
//   node tests/smoke.mjs --no-package --only=phone  run one session (desktop or phone): iterating on a driver
//   GAME_DIR=addons/starter-arena npm run smoke     another game (here the demo add-on)
//   npm run smoke -- --port=5182                    serve on a fixed port (default: any free one)
//
// The engine's part, for every game. Desktop 1280×720: click to start (the audio unlock) →
// menu → How to play → Play → countdown → playing (or straight to playing when the game skips
// the countdown, Game.skipCountdown) → [the game's desktop driver] → Esc pause: sim steps, the
// presentation clock and the game's stats frozen → Settings from the pause card returns to it →
// Resume: they advance → window blur does what the game's focus mode says (pauseOnBlur "pause":
// pauses; "input": keeps running with input withheld until focus returns; "none": keeps running;
// then Escape pauses) → Escape resumes → pause → Quit to menu. Phone
// 390×844 with touch emulation and reduced motion: tap to start → Play → [the game's phone
// driver] → the HUD pause button → frozen → Resume → Restart round (a new round, through a new
// countdown unless the game skips it; absent when the game declares GameModule.pause.restart
// false) → Quit to menu. A driver that ends on the results card goes back to the menu from there
// instead.
//
// The game's drivers come from its game.json "smoke" (a module under the game folder that
// default-exports { play?, desktop?: { query?, play?, drive(t) }, phone?: { query?, play?, drive(t) },
// allowedOrigins?, sharedWorld?, cleanup? }; `t` is the context built in session() below;
// tests/lib/smoke-driver.mjs checks the shape). They play the game's own round with real input.
// `play` is a selector for the menu entry pressed for Play (per session, or for both), for a menu
// with more than one data-act="play" entry; default the first `.mbtn[data-act="play"]`. An online
// game's driver starts its own local server at import (the package is built after that, so it can
// set the shell values the build reads), lists it in `allowedOrigins`, sets `sharedWorld: true`
// when that world goes on while the local round is paused, and stops it in `cleanup()`.
//
// Fails on console errors, page exceptions, missed requests (/__misses), a request or WebSocket
// to any origin but the release server and the driver's fixtures, dev-only UI in the release, a
// dead audio context after the start gesture, or a second tab.
// Screenshots: out/smoke/<game id>/<session>-<step>.png (ignored); look at them.
//
// A full run (both renderers, both sessions) that passes records release/web-smoke.json: the source build id it played.
// deploy:web and wavedash:push refuse a package whose build id has none (docs/release.md, Preflight). Every run removes the
// previous record first, so a failed or partial run leaves none.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, launchChrome } from "./lib/cdp.mjs";
import { isForeignRequest, loadSmokeDriver } from "./lib/smoke-driver.mjs";
import { loadActiveGame } from "../scripts/lib/active-game.mjs";
import { smokeReceipt, verifyTarget } from "../scripts/lib/package-game.mjs";
import { releasePaths } from "../scripts/lib/release-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rendererArg = args.find((a) => a.startsWith("--renderer="))?.split("=")[1] ?? "all";
if (!["all", "auto", "webgpu", "webgl2"].includes(rendererArg)) throw new Error("--renderer must be all, auto, webgpu or webgl2");
const active = loadActiveGame();
const OUT = join(ROOT, "out/smoke", active.manifest.id);
mkdirSync(OUT, { recursive: true });
/** The game's driver (loaded in the run below, before packaging: it may start a fixture and set the shell values the build reads). */
let driver = { allowedOrigins: [], sharedWorld: false };

const log = (...a) => console.log("[smoke]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures.push(what);
    console.error(`[smoke] FAIL ${what}`);
  }
};

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: ROOT, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${argv.join(" ")} exited ${code}`))));
  });
}

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(port) {
  const proc = spawn(process.execPath, ["scripts/serve-release.mjs", "web", "--port", String(port)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`release server did not start: ${text}`)), 15000);
    const on = (d) => {
      text += d;
      if (text.includes("/builds/")) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on("data", on);
    proc.stderr.on("data", on);
    proc.on("exit", (c) => reject(new Error(`release server exited ${c}: ${text}`)));
  });
  const base = text.match(/http:\/\/\S+\/builds\/\S+\//)[0];
  return { proc, base, stop: () => proc.exitCode === null && proc.kill("SIGTERM") };
}

/** Key codes drivers may use: [key, windowsVirtualKeyCode]. */
const KEYS = {
  KeyW: ["w", 87], KeyA: ["a", 65], KeyS: ["s", 83], KeyD: ["d", 68], KeyP: ["p", 80], KeyM: ["m", 77], KeyB: ["b", 66], KeyT: ["t", 84],
  KeyQ: ["q", 81], KeyE: ["e", 69], KeyF: ["f", 70], KeyX: ["x", 88], KeyV: ["v", 86], KeyG: ["g", 71],
  ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  Space: [" ", 32], Enter: ["Enter", 13], Escape: ["Escape", 27],
};

/** One browser session (desktop or phone). */
async function session({ name, renderer, width, height, touch, reducedMotion = false, defaultQuery, plan, play = '.mbtn[data-act="play"]' }) {
  const chrome = await launchChrome({ width, height });
  const cdp = await connect(chrome.wsUrl);
  const problems = [];
  const foreign = [];
  try {
    const [target] = await cdp.pages();
    const p = await cdp.attach(target.targetId);
    p.on((m) => {
      if (m.method === "Runtime.exceptionThrown") problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "assert")) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "warning" && process.env.SMOKE_WARN) console.log("[warn]", m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 400));
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
      // The release is hermetic on the web target: a request or WebSocket to any other origin (a stats endpoint, an SDK, a hosted
      // game server) is a leak. Only the game driver's own local fixtures (allowedOrigins) are let through.
      const url = m.method === "Network.requestWillBeSent" ? m.params.request.url : m.method === "Network.webSocketCreated" ? m.params.url : null;
      if (url && isForeignRequest(url, server.base, driver.allowedOrigins)) foreign.push(url);
    });
    await p.S("Runtime.enable");
    await p.S("Network.enable");
    await p.S("Log.enable");
    await p.S("Page.enable");
    // The harness checks itself: an exception and a console.error thrown on purpose (on about:blank) must reach `problems`, or a
    // listener that never fires would let every run pass without looking (it happened: tests/lib/cdp.mjs on()).
    await p.S("Runtime.evaluate", { expression: "setTimeout(() => { throw new Error('smoke self-test') }); console.error('smoke self-test'); 0" });
    for (let i = 0; i < 50 && problems.length < 2; i++) await sleep(20);
    check(problems.length === 2 && problems.some((e) => e.startsWith("exception:")) && problems.some((e) => e.startsWith("console.error:")),
      `${name}: the harness hears page errors (a deliberate throw and console.error were caught: ${problems.length})`);
    problems.length = 0;
    // Headless windows never have focus; without this the game's blur handler would pause it.
    await p.S("Emulation.setFocusEmulationEnabled", { enabled: true });
    await p.S("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: touch ? 2 : 1, mobile: !!touch });
    if (touch) await p.S("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    if (reducedMotion) await p.S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const url = new URL(plan?.query ?? defaultQuery, server.base);
    url.searchParams.set("renderer", renderer);
    await p.S("Page.navigate", { url: url.href });

    const shot = async (label) => {
      const { data } = await p.S("Page.captureScreenshot", { format: "png" });
      const file = join(OUT, `${name}-${label}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      log(`screenshot ${file}`);
    };
    const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.closest('[hidden]'); })()`;
    // null for an element that is missing, hidden or has no box (display: none from a stylesheet): a press must not click the corner.
    const center = (sel) => p.evalJS(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.closest('[hidden]') || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    /** A trusted click (mouse) or tap (touch) on an element's centre. CDP Enter doesn't press native buttons. */
    const press = async (sel) => {
      const c = await center(sel);
      if (!c) throw new Error(`${sel} is not visible${sel === "#pause-restart" ? " (a game without Restart round declares GameModule.pause: { restart: false })" : ""}`);
      if (touch) {
        await p.S("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1], id: 1 }] });
        await p.S("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await p.S("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
        await p.S("Input.dispatchMouseEvent", { type: "mousePressed", x: c[0], y: c[1], button: "left", buttons: 1, clickCount: 1 });
        await p.S("Input.dispatchMouseEvent", { type: "mouseReleased", x: c[0], y: c[1], button: "left", buttons: 0, clickCount: 1 });
      }
    };
    const held = new Set();
    const key = async (code, down) => {
      if (!KEYS[code]) throw new Error(`smoke: no key mapping for ${code} (add it to KEYS in tests/smoke.mjs)`);
      const [k, vk] = KEYS[code];
      if (down === held.has(code)) return;
      down ? held.add(code) : held.delete(code);
      await p.S("Input.dispatchKeyEvent", { type: down ? "keyDown" : "keyUp", code, key: k, windowsVirtualKeyCode: vk });
    };
    const tap = async (code) => {
      await key(code, true);
      await key(code, false);
    };
    const game = (expr) => p.evalJS(`window.__game.${expr}`);
    const phase = () => game("phase()");
    const waitPhase = (want, ms, what = want) => p.waitFor(`window.__game.phase() === ${JSON.stringify(want)}`, ms, what);
    /** Everything that must stand still while paused. */
    const clocks = () => p.evalJS("({ steps: window.__game.simSteps(), clock: window.__game.clock(), stats: JSON.stringify(window.__game.stats()) })");
    const t = { name, p, game, key, tap, press, shot, check, log, sleep, touch, width, height, visible, waitPhase, clocks };
    /**
     * Record every phase from here on, and whether a countdown number or "GO!" ever showed: a game may skip the countdown
     * (Game.skipCountdown), and then the round must go straight to playing with nothing on #countdown.
     */
    const recordPhases = () => p.evalJS(`(() => {
      window.__smokeObs?.forEach((o) => o.disconnect());
      const rec = window.__smokePhases = { phases: [document.body.dataset.phase], countdownShown: false };
      const cd = document.querySelector("#countdown");
      const seen = () => { if (!cd.hidden && cd.textContent) rec.countdownShown = true; };
      const a = new MutationObserver(() => { const ph = document.body.dataset.phase; if (rec.phases.at(-1) !== ph) rec.phases.push(ph); });
      a.observe(document.body, { attributes: true, attributeFilter: ["data-phase"] });
      const b = new MutationObserver(seen);
      b.observe(cd, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
      window.__smokeObs = [a, b];
      return 0;
    })()`);
    const recorded = () => p.evalJS("({ ...window.__smokePhases, hidden: document.querySelector('#countdown').hidden })");
    /** After a start: was it the countdown? If not, it must have gone straight to playing with no number on screen. */
    const skippedCountdown = async (from) => {
      const r = await recorded();
      if (r.phases.includes("countdown")) return false;
      check(r.phases.at(-1) === "playing" && r.phases.length === 2 && !r.countdownShown && r.hidden,
        `${name}: the game skips the countdown: ${from} → playing at once (${r.phases.join(" → ")}, no number shown)`);
      return true;
    };

    await p.waitFor(`!!window.__game && ${visible("#press-start")}`, 30000, "boot + start button");
    const graphics = await game("graphics()");
    check(renderer === "auto" || graphics.backend === renderer, `${name}: selected ${graphics.backend}, HDR ${graphics.hdr}`);
    await sleep(500);
    await shot("title");
    await press("#press-start");
    await waitPhase("menu", 10000);
    // The start press is the audio unlock gesture (muted output, but the context must run). Resuming the context is asynchronous: without
    // a transition to wait through, the menu can be up before it reports running, so give it up to 5 s.
    const unlocked = await p.waitFor("window.__game.runtime.audio.unlocked", 5000, "audio context running").then(() => true, () => false);
    check(unlocked, `${name}: audio context running after the start gesture`);
    if (reducedMotion) {
      const rm = await p.evalJS("({ cls: document.body.classList.contains('reduced-motion'), shake: window.__game.runtime.shake })");
      check(rm.cls && rm.shake === 0, `${name}: system reduced-motion preference honoured (class ${rm.cls}, shake ${rm.shake})`);
    }
    await sleep(1400); // let the menu and camera settle before capturing / hit-testing
    await shot("menu");
    const devUi = await p.evalJS("document.querySelectorAll('#tuning, #dbg, #tune-toggle, #dbg-toggle, [data-dev-only], .mbtn.dev').length");
    check(devUi === 0, `${name}: no dev-only UI in the release build`);
    if (!touch) {
      // A popup from the menu: How to play, else the game's first own entry (GameModule.menu.extra; a game may take help out), else Settings.
      const help = await p.evalJS(visible('.mbtn[data-act="help"]'));
      const extra = help ? null : await p.evalJS(`[...document.querySelectorAll('#menu .mbtn[data-act^="extra:"]')].find((b) => !b.closest('[hidden]'))?.dataset.act.slice(6) ?? null`);
      const [btn, pop, close] = help
        ? ['.mbtn[data-act="help"]', "#help-pop", "#help-pop .row-buttons [data-close]"]
        : extra
          ? [`.mbtn[data-act="extra:${extra}"]`, `#extra-${extra}-pop`, `#extra-${extra}-pop .row-buttons [data-close]`]
          : ['.mbtn[data-act="settings"]', "#settings-pop", "#settings-pop .pclose[data-close]"];
      await press(btn);
      await p.waitFor(visible(pop), 3000, `${pop} popup`);
      await sleep(500);
      await shot(help ? "help" : extra ? `extra-${extra}` : "settings-menu");
      await press(close);
      await p.waitFor(`!${visible(pop)}`, 3000, `${pop} closed`);
      await sleep(300);
    }
    await recordPhases();
    await press(plan?.play ?? play);
    await p.waitFor("['countdown', 'playing'].includes(window.__game.phase())", 5000, "countdown or play");
    if (!(await skippedCountdown("menu"))) {
      await waitPhase("countdown", 5000);
      // A game intro (Game.beginIntro) holds the numbers until it ends, then goes straight to GO; its length is the
      // game's own (and a slow software renderer stretches it), so allow it time and accept "no number" for it.
      await p.waitFor("document.querySelector('#countdown').textContent === '2' || window.__game.phase() === 'playing'", 120000, "countdown 2 (or a game intro into play)");
      await sleep(200); // the number's pop-in
      await shot("countdown");
      await waitPhase("playing", 120000);
      check(true, `${name}: Play went through the countdown into play (${(await recorded()).phases.join(" → ")})`);
    }

    if (plan?.drive) await plan.drive(t);
    else {
      await sleep(1200);
      await shot("play");
    }

    const after = await phase();
    if (after === "results") {
      await press("#results-menu");
    } else if (after === "playing") {
      // Pause freezes the sim clock, the presentation clock and the game's stats.
      if (touch) await press("#btn-pause");
      else await tap("Escape");
      await p.waitFor(`window.__game.phase() === 'paused' && ${visible("#pause-pop")}`, 3000, "paused");
      const a = await clocks();
      await sleep(1000);
      const b = await clocks();
      // A shared world (driver.sharedWorld) goes on on the server while this player is paused, so its stats may change; the local sim and clock may not.
      check(a.steps === b.steps && a.clock === b.clock && (driver.sharedWorld || a.stats === b.stats),
        `${name}: pause froze the sim (${a.steps} → ${b.steps} steps), the presentation clock and ${driver.sharedWorld ? "not the stats (a shared world goes on)" : "the stats"}`);
      await shot("pause");
      if (!touch) {
        // Settings opened from the pause card return to it and never resume the round.
        await press("#pause-settings");
        await p.waitFor(visible("#settings-pop"), 3000, "settings from pause");
        await sleep(400);
        await shot("settings");
        await tap("Escape");
        await p.waitFor(`window.__game.phase() === 'paused' && ${visible("#pause-pop")}`, 3000, "back to the pause card");
        check((await clocks()).steps === b.steps, `${name}: closing Settings returned to the pause card, still paused`);
        await sleep(300);
      }
      // Under a slow software renderer the pause card may still be popping in (back from Settings): press Resume once it has settled.
      await p.waitFor(`document.querySelector('#pause-pop').getAnimations({ subtree: true }).every((a) => a.playState !== 'running')`, 3000, "pause card settled");
      await press("#pause-resume");
      await waitPhase("playing", 3000, "resumed");
      await sleep(500);
      const c = await clocks();
      check(c.steps > b.steps && c.clock > b.clock, `${name}: resume advanced the sim (${b.steps} → ${c.steps} steps) and the presentation clock`);
      if (!touch) {
        // Focus loss (a synthetic window blur: proves the handler, not OS tab switching) does what the game's focus
        // mode says (GameModule.pauseOnBlur, or rt.setPauseOnBlur): "pause" pauses; "input" keeps the round running
        // with input withheld until focus returns; "none" keeps it running. Then Escape on the pause card resumes
        // through the Frontend's popup handling.
        const mode = await game("pauseOnBlur()");
        const away = await clocks();
        if (mode === "pause") {
          await p.evalJS("window.dispatchEvent(new Event('blur')); 0");
          await waitPhase("paused", 3000, "blur pause");
          check(true, `${name}: window blur paused the round`);
        } else {
          // As a real focus loss: hasFocus() false too, or a released mouse capture reads as Esc and pauses in every mode.
          await p.evalJS("document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); 0");
          await sleep(600);
          const r = await p.evalJS("({ phase: window.__game.phase(), steps: window.__game.simSteps(), withheld: window.__game.runtime.inputSuspended })");
          check(r.phase === "playing" && r.steps > away.steps && r.withheld === (mode === "input"),
            `${name}: window blur under pauseOnBlur "${mode}" left the round running (${away.steps} → ${r.steps} steps), input ${r.withheld ? "withheld" : "live"}`);
          await p.evalJS("delete document.hasFocus; window.dispatchEvent(new Event('focus')); 0");
          if (mode === "input") check(!(await p.evalJS("window.__game.runtime.inputSuspended")), `${name}: focus back handed the input back`);
          await tap("Escape");
          await waitPhase("paused", 3000, "Escape pause");
        }
        await sleep(500); // let the card finish opening and take focus
        await tap("Escape");
        await waitPhase("playing", 3000, "Escape resume");
        check(true, `${name}: Escape on the pause card resumed`);
        await sleep(300);
        await tap("Escape");
      } else if (await p.evalJS("document.body.dataset.restart === 'off'")) {
        // GameModule.pause.restart false (a shared world one player cannot restart): the button must be gone, not merely styled away.
        await press("#btn-pause");
        await p.waitFor(`window.__game.phase() === 'paused' && ${visible("#pause-pop")}`, 3000, "paused");
        const shown = await p.evalJS(`(() => { const e = document.querySelector("#pause-restart"); return !!e && !e.closest("[hidden]") && e.getClientRects().length > 0; })()`);
        check(!shown, `${name}: the game declares no Restart round (pause.restart false), and the pause card shows none`);
      } else {
        // Restart round from the pause card: a new round (not a resume), through a fresh countdown unless the game skips it.
        await press("#btn-pause");
        await p.waitFor(`window.__game.phase() === 'paused' && ${visible("#pause-pop")}`, 3000, "paused to restart");
        await sleep(400);
        const roundsBefore = await game("rounds()");
        await recordPhases();
        await press("#pause-restart");
        await p.waitFor("['countdown', 'playing'].includes(window.__game.phase())", 3000, "restart countdown or play");
        if (!(await skippedCountdown("paused"))) {
          await waitPhase("countdown", 3000, "restart countdown");
          await waitPhase("playing", 120000, "restarted round playing"); // (a game intro runs again here)
        }
        const roundsAfter = await game("rounds()");
        check(roundsAfter === roundsBefore + 1, `${name}: Restart round laid out a new round (${roundsBefore} → ${roundsAfter}) and went into play`);
        await sleep(300);
        await press("#btn-pause");
      }
      await p.waitFor(`window.__game.phase() === 'paused' && ${visible("#pause-pop")}`, 3000, "paused to quit");
      await sleep(400);
      await p.waitFor(`document.querySelector('#pause-pop').getAnimations({ subtree: true }).every((a) => a.playState !== 'running')`, 3000, "pause card settled");
      await press("#pause-quit");
    } else throw new Error(`${name}: the game's driver left the page in phase "${after}" (expected playing or results)`);
    await p.waitFor(`window.__game.phase() === 'menu' && ${visible("#menu")}`, 6000, "back at the menu");
    check(true, `${name}: back at the menu (from ${after})`);
    await sleep(1200);
    await shot("menu-again");

    // Dev-only keys do nothing in release.
    await tap("KeyB");
    await tap("KeyT");
    check((await p.evalJS("document.querySelectorAll('#tuning, #dbg').length")) === 0, `${name}: B/T open no dev panel in release`);
    const pages = await cdp.pages();
    check(pages.length === 1, `${name}: one page open (${pages.length})`);
    log(`${name}: ${await game("fps()")} fps (headless, software timing; not a device benchmark)`);
    for (const e of problems) console.error(`[smoke] ${name}: ${e}`);
    check(problems.length === 0, `${name}: no console errors or exceptions`);
    check(foreign.length === 0, `${name}: no request left the local server${foreign.length ? `: ${[...new Set(foreign)].join(", ")}` : " (the play stats stay silent under automation)"}`);
  } finally {
    cdp.close();
    await chrome.close();
  }
}

let server;
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const smokeRecord = releasePaths(ROOT, "web").smoke;
rmSync(smokeRecord, { force: true }); // only this run's full pass may stand
try {
  log(`active game: ${active.manifest.title} (${active.dir}/)${active.manifest.smoke ? `, driver ${active.dir}/${active.manifest.smoke}` : ", no game driver (engine checks only)"}`);
  driver = await loadSmokeDriver(active);
  if (driver.allowedOrigins.length) log(`the driver's fixtures may be reached: ${driver.allowedOrigins.join(", ")}`);
  if (!args.includes("--no-package")) await run(process.execPath, ["scripts/package-web.mjs"]);
  const port = args.find((a) => a.startsWith("--port="))?.slice(7);
  if (port !== undefined && !/^[1-9][0-9]{0,4}$/.test(port)) throw new Error(`--port must be a port number (got ${port})`);
  server = await startServer(port ? Number(port) : await freePort());
  log(`serving release/web at ${server.base}`);
  if (only && only !== "desktop" && only !== "phone") throw new Error(`--only must be desktop or phone (got ${only})`);
  for (const renderer of rendererArg === "all" ? ["webgpu", "webgl2"] : [rendererArg]) {
    if (only !== "phone") await session({ name: `${renderer}-desktop`, renderer, width: 1280, height: 720, touch: false, defaultQuery: "?seed=7", plan: driver.desktop, play: driver.play });
    if (only !== "desktop") await session({ name: `${renderer}-phone`, renderer, width: 390, height: 844, touch: true, reducedMotion: true, defaultQuery: "?seed=3", plan: driver.phone, play: driver.play });
  }
  const misses = await (await fetch(new URL("/__misses", server.base))).json();
  check(misses.length === 0, `no missed requests under the nested prefix${misses.length ? `: ${misses.join(", ")}` : ""}`);
} catch (e) {
  failures.push(String(e));
  console.error("[smoke] error:", e);
} finally {
  server?.stop();
  // The driver's fixtures (a local game server, its data folder), stopped whether the run passed or not.
  await Promise.resolve(driver.cleanup?.()).catch((e) => failures.push(`the driver's cleanup() failed: ${e}`));
}
if (!failures.length) {
  if (rendererArg !== "all" || only) log("a partial run (--renderer or --only): no smoke pass recorded; uploads need a full run");
  else {
    try {
      const report = await verifyTarget("web"); // the package played is still the one in release/web
      if (report.gameId !== active.manifest.id) throw new Error(`release/web holds ${report.gameId}, not ${active.manifest.id}`);
      writeFileSync(smokeRecord, `${JSON.stringify(smokeReceipt(report, { renderers: ["webgpu", "webgl2"], sessions: ["desktop", "phone"] }), null, 2)}\n`);
      log(`recorded release/web-smoke.json: uploads built from ${report.buildId} may go out`);
    } catch (e) {
      failures.push(`could not record the pass: ${e.message}`);
      console.error(`[smoke] FAIL could not record the pass: ${e.message}`);
    }
  }
}
if (failures.length) {
  console.error(`[smoke] ${failures.length} failure(s)`);
  process.exit(1);
}
log("all checks passed");
