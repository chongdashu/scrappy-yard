// Browser-only shell fixture. Uses the active game's assets/ABI, with synthetic
// outcomes and an input-driven eye to test optional engine hooks independently.
import base from '@fixture-base-game';
import type { InputSnapshot } from '../../src/input';
import type { GameModule, Game } from '../../src/game';
import type { GameRuntime } from '../../src/runtime';

const fixture: GameModule = {
  ...base,
  camera: 'first-person',
  // The engine's wipe by default; `?start=cut` takes the cut start (tests/frontend.mjs runs both).
  startTransition: new URLSearchParams(location.search).get('start') === 'cut' ? 'cut' : undefined,
  // Keeps the round running, input withheld, while the window is away (the default pauses): checked by tests/frontend.mjs.
  pauseOnBlur: 'input',
  actions: { use: ['Mouse:0', 'Space', 'Pad:0'] },
  buttons: [{ action: 'use', label: 'USE', size: 'large' }],
  // The game's own popups (one also on the pause card) in place of "How to play": checked by tests/frontend.mjs.
  help: false,
  menu: { extra: [
    { id: 'about', label: 'About', body: '<p>Fixture <a href="#about">link</a> &amp; text.</p>', pause: true },
    { id: 'credits', label: 'Credits', title: 'Credits <&> "quotes"', body: '<p>Nobody</p>', close: 'Done' },
    // `?link`: an entry that is a link (href), followed by tests/frontend.mjs's start passes.
    ...(new URLSearchParams(location.search).has('link') ? [{ id: 'scene', label: 'Scene link', href: '?scene=linked' }] : []),
  ] },
  create() {
    const game: Game = base.create();
    let rt: GameRuntime | null = null;
    let skip = false;
    const load = game.load.bind(game);
    game.load = (r, progress) => {
      rt = r;
      r.hooks.setSkipCountdown = (on: boolean) => (skip = on); // tests/frontend.mjs turns it on for its last start
      return load(r, progress);
    };
    let intro = false, introTime = 0, playingTime = 0, yaw = 0, rounds = 0;
    let used = 0, moved = 0, looked = 0, began = false;
    const frame = game.frame.bind(game), reset = game.reset.bind(game);
    const start = game.startRound.bind(game), stats = game.stats.bind(game);
    game.reset = () => {
      reset();
      introTime = playingTime = yaw = used = moved = looked = 0;
      began = false;
      rounds++;
    };
    // Off until the test says so, whatever the base game does: the checks above it drive the intro and the countdown.
    game.skipCountdown = () => skip;
    game.beginIntro = () => (intro = true);
    game.introActive = () => intro;
    window.addEventListener('click', () => { if (intro) intro = false; });
    game.startRound = () => { began = true; start(); };
    game.round = () => began ? (used && playingTime > 0.6 ? 'won' : 'playing') : 'ready';
    game.input = (s: InputSnapshot) => {
      yaw += s.lookX;
      moved = Math.max(moved, Math.hypot(s.moveX, s.moveY));
      looked = Math.max(looked, Math.abs(s.lookX));
      if (s.pressed.has('use')) used++;
    };
    game.eye = () => ({ x: 0, y: 2, z: -4, yaw, pitch: 0 });
    game.frame = (dt, snap, phase) => {
      if (intro) { introTime += dt; if (introTime > 1.4) intro = false; }
      if (phase === 'playing') playingTime += dt;
      return frame(dt, snap, phase);
    };
    game.stats = () => ({ ...stats(), yaw, used, moved, looked, rounds, intro: +intro });
    game.summary = () => {
      const summary = { won: true, ribbon: 'Fixture', title: 'Round complete', rows: [['Actions', String(used)]] as [string, string][], note: 'Synthetic outcome for shell checks' };
      if (rounds !== 1) return summary;
      const custom = document.createElement('div');
      const heading = document.createElement('h2');
      heading.textContent = 'Custom round result';
      custom.append(heading);
      custom.setAttribute('aria-hidden', 'true');
      const extra = document.createElement('div');
      const about = document.createElement('button');
      about.className = 'btn small';
      about.id = 'results-about';
      about.textContent = 'About';
      about.addEventListener('click', () => rt?.openPopup('about', about));
      extra.append('Optional extra ', about);
      return { ...summary, custom, extra, buttons: { again: false, menu: 'Continue' } };
    };
    return game;
  },
};
export default fixture;
