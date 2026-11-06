// The game's entry module: the engine imports this as `@game` (see GameModule in the
// engine's src/game.ts). Kickoff build: the scrapyard greybox gym (`?scene=gym`, default), the
// asset viewer stub (`?scene=viewer`) and the character animation test (`?scene=character`). game.json holds identity and build settings.
import "./style.css";
import type { GameModule } from "@engine/game";
import { ScrapyardGame } from "./game";
import { HUD_OVERLAY, HUD_TOP } from "./hud";
import { ABI, PARAMS } from "./sim-abi";
import { installMenuSkin } from "./menu-skin";
import { startLeaderboard } from "./leaderboard";

installMenuSkin();

const game: GameModule = {
  abi: ABI,
  // create() runs after platform.init(), so the leaderboard can read the host's player (Wavedash) before its first sync.
  create: () => {
    startLeaderboard();
    return new ScrapyardGame();
  },
  // Scrapyard shutter (riveted steel doors with hazard-tape edges) instead of the engine's circular wipe, on Play and on the way back to the menu.
  playTransition: "wipe",
  wipeStyle: "shutter",
  tips: [
    "Tip: hold A/D or drag the stick to slide freely across the track.",
    "Tip: jump barrels and gaps; scrap cars have to be dodged.",
    "Tip: orange/red/pink lamps + a tick mark hazards (not the gold hex nuts).",
    "Tip: every barrel you hit slows you — keep moving and grab the hex nuts.",
  ],
  hud: { top: HUD_TOP, overlay: HUD_OVERLAY },
  // Published build: no How to play on menu or pause (owner, 2026-11-05). Tips cover the basics.
  help: false,
  audio: {
    tracks: {
      menu: { url: "assets/audio/bgm_menu.mp3", loopStart: 0, loopEnd: 54, gain: 0.4 },
      play: { url: "assets/audio/bgm_play.mp3", loopStart: 0, loopEnd: 84, gain: 0.6, preload: false },
    },
  },
  params: PARAMS,
  // The game supplies an oncoming eye every frame (Game.eye); no mouse look.
  camera: "first-person",
  look: false,
  startTransition: "cut",
  actions: {
    jump: ["Space", "KeyW", "ArrowUp", "Pad:0", "Pad:12"],
    laneLeft: ["KeyA", "ArrowLeft", "Pad:14"],
    laneRight: ["KeyD", "ArrowRight", "Pad:15"],
    bounds: ["KeyX", "Pad:3"],
    camera: ["KeyV", "Pad:2"],
    practice: ["KeyG"],
    // Character test scene only (game/src/character.ts); unused by the gym.
    charClip1: ["Digit1"],
    charClip2: ["Digit2"],
    charClip3: ["Digit3"],
    charClip4: ["Digit4"],
    charSeq: ["KeyS"],
    charPause: ["KeyP"],
    charStepBack: ["Comma"],
    charStepFwd: ["Period"],
    charSlower: ["BracketLeft"],
    charFaster: ["BracketRight"],
    charTread: ["KeyT"],
  },
  buttons: [{ action: "jump", label: "JUMP", size: "large", title: "Jump" }],
  // Sunset scrapyard: purple zenith, orange horizon (mockup D), no blockout grid on the track.
  style: {
    skyZenith: [0.33, 0.2, 0.52],
    skyHorizon: [1.0, 0.6, 0.38],
    cloudTint: [1.0, 0.72, 0.62],
    grid: 0,
    warmth: 0.7,
    haze: 0.8,
    hazeStart: 30,
    hazeEnd: 110,
    bloom: 0.75,
  },
  // Dev-only scene links (dropped from production builds).
  menu: import.meta.env.DEV
    ? {
        extra: [
          // autostart: land in the scene, not back on the same menu (felt like a dead click over Tailscale).
          { id: "gym", label: "Greybox gym", href: "?scene=gym&gym&autostart" },
          { id: "viewer", label: "Asset viewer", href: "?scene=viewer&autostart" },
          { id: "character", label: "Character test", href: "?scene=character&autostart" },
        ],
      }
    : undefined,
};

export default game;
