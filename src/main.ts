// Entry: platform → settings → runtime boot → front-end flow. The active game arrives through
// the `@game` alias (its <gameDir>/src/index.ts, a GameModule; see src/game.ts) and its
// identity through src/config.ts; everything else wired here is engine.
//
// Engine URL options: ?seed=<n> (sim RNG), ?capture (deterministic stepping via
// __game.step), ?autostart (skip title and menu), ?mobileView (dev server only: play
// as the Mobile view, src/dev/mobile-view.ts). Games add their own (e.g. the
// starter-arena add-on's ?limit and ?placeholders).
import "./style.css";
import game from "@game";
import { GAME } from "./config";
import { platform } from "./platform";
import { GameRuntime } from "./runtime";
import { AudioBus } from "./audio";
import { Frontend } from "./ui/frontend";
import { motion } from "./ui/tween";
import { Flow } from "./flow";
import { DEFAULT_ACTIONS } from "./input";
import { DEFAULT_STYLE, type Style } from "./gpu/renderer";
import { bindSettingsUI, createSettingsSave, reducedMotion } from "./settings";
import { installMenuExtras, removeHelp, removeRestart } from "./ui/menu-extra";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const q = new URLSearchParams(location.search);

/** "How to play" when the game supplies none: the engine's own controls. */
const DEFAULT_HELP = `<ul class="help-list">
  <li><span class="ico" aria-hidden="true">❚❚</span><span><b>Pause:</b> Esc, P or Start.</span></li>
  <li><span class="ico" aria-hidden="true">🔊</span><span><b>Mute:</b> M.</span></li>
</ul>`;

// The game's words and HUD go in before anything can show them.
document.title = GAME.title;
for (const el of document.querySelectorAll<HTMLElement>("[data-game-title]")) el.textContent = GAME.title;
for (const el of document.querySelectorAll<HTMLElement>("[data-game-tagline]")) {
  el.textContent = game.tagline ?? "";
  el.hidden = !game.tagline;
}
$("#hud-game-top").innerHTML = game.hud?.top ?? "";
$("#hud-game").innerHTML = game.hud?.overlay ?? "";
if (game.help === false) removeHelp();
else $("#help-body").innerHTML = game.help ?? DEFAULT_HELP;
if (game.pause?.restart === false) removeRestart(); // a round the player cannot restart alone (a shared world)
if (game.menu?.extra?.length) installMenuExtras(game.menu.extra); // the game's own popups (About, Credits); none by default

// The host adapter connects first: some hosts restore saves during init().
await platform.init();
const settings = createSettingsSave();
const audio = new AudioBus(game.audio?.tracks); // the game's music tracks, if it ships any (src/music.ts)
if (game.audio?.volumes) audio.setVolumes(game.audio.volumes); // the game's mix; the settings panel only sets master (below)
audio.prepare();
const frontend = new Frontend(audio, game.tips ?? []);
frontend.setWipeStyle(game.wipeStyle);
frontend.setProgress(0.02);

const seed = Number.isFinite(Number(q.get("seed"))) && q.get("seed") ? Number(q.get("seed")) >>> 0 : 1;
// The dev Mobile view: the window it opened (its name lasts through reloads and links), or ?mobileView. False in a release build.
const mobileView = import.meta.env.DEV && (window.name === "vgd-mobile-view" || q.has("mobileView"));
const play = game.create();
const rt = await GameRuntime.boot($<HTMLCanvasElement>("#game"), play, {
  seed,
  abi: game.abi,
  audio,
  actions: { ...DEFAULT_ACTIONS, ...game.actions },
  rig: game.rig,
  camera: game.camera,
  look: game.look,
  buttons: game.buttons,
  pauseOnBlur: game.pauseOnBlur,
  mobileView,
  onProgress: (p, label) => frontend.setProgress(p, label),
});

if (rt) {
  /** The look before player settings (the DEV tuning panel edits this). */
  const baseStyle: Style = { ...DEFAULT_STYLE, ...game.style };
  const look: Style = { ...baseStyle };
  const apply = () => {
    const s = settings.data;
    audio.setVolumes({ master: s.volume });
    audio.setMuted(s.muted);
    rt.style = { ...look, shadow: s.shadows ? look.shadow : 0, inkPx: s.outlines ? look.inkPx : 0 };
    motion.reduced = reducedMotion(s);
    rt.shake = motion.reduced ? 0 : 1;
    const mute = $("#btn-mute");
    mute.textContent = s.muted ? "🔇" : "🔊";
    mute.setAttribute("aria-label", s.muted ? "Unmute (M)" : "Mute (M)");
  };
  apply();
  audio.setHostMuted(platform.hostMuted);
  platform.onHostMute((m) => audio.setHostMuted(m));
  const settingsUI = bindSettingsUI($("#settings-pop"), () => settings.data, () => (apply(), settings.save()), () => audio.press());
  if (platform.ownFullscreen) {
    $("#set-fullscreen-row").hidden = false;
    $("#set-fullscreen").addEventListener("click", () => void platform.toggleFullscreen());
  }
  // Release builds name themselves in Settings (the packager sets VITE_BUILD_ID), so "is the new
  // build live yet?" can be answered by looking. A dev server has no build id and shows nothing.
  const buildId = import.meta.env.VITE_BUILD_ID as string | undefined;
  if (buildId) {
    const line = $("#build-id");
    line.textContent = `Build ${buildId}`;
    line.hidden = false;
  }

  const flow = new Flow(rt, play, frontend, {
    toggleMute: () => {
      settings.data.muted = !settings.data.muted;
      settings.save();
      apply();
      settingsUI.paint();
    },
    settingsOpened: () => settingsUI.paint(),
  }, { playTransition: game.playTransition }); // (the focus policy starts in rt.pauseOnBlur: GameModule.pauseOnBlur, or what the game's load() set)

  // Dev server only. `import.meta.env.DEV` is false in production builds, so
  // these imports (and their vgd:dev-only markers) are dropped from release bundles.
  // The Mobile view gets none of them: it shows what a player sees on a phone, and the main window keeps the panels.
  if (import.meta.env.DEV && !mobileView) {
    void import("./dev/tuning").then(({ installTuning }) => installTuning(rt.sim, game.params ?? [], look, apply, baseStyle));
    void import("./dev/debug-panel").then(({ installDebugPanel }) => installDebugPanel(() => play.debugActions?.() ?? [], () => play.debugInfo?.() ?? ""));
    void import("./dev/mobile-view").then(({ installMobileView }) => installMobileView(rt));
    const link = Object.assign(document.createElement("button"), { className: "mbtn dev", textContent: "Model preview (dev)" });
    link.dataset.act = "preview";
    $(".menu-list").appendChild(link);
  }

  rt.phase = "title";
  rt.start();
  if (q.has("autostart")) {
    $("#boot").hidden = true;
    flow.autostart();
    platform.ready();
  } else {
    // The title's first press doubles as the audio unlock gesture.
    // GameModule.startTransition "cut": no wipe, and the world on the ready screen carries straight on into the menu.
    const cut = game.startTransition === "cut";
    const start = frontend.waitForStart(() => audio.unlock(), () => flow.enterMenu(cut), cut ? "cut" : "wipe");
    platform.ready();
    await start;
  }
}
