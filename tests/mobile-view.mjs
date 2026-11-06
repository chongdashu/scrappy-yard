// The dev Mobile view in a browser, on the dev server (it is dev-only, so the release tests never see it): the button opens
// a phone-sized window in play, where the page is marked for touch, the touch buttons show, a mouse drag drives the move
// stick and no dev panels show; it stays a Mobile view through a reload; Rotate turns it; the button closes it. `?mobileView`
// makes any window one. Headless Chrome ignores a pop-up's size, so the size is checked as asked for (window.open, resizeTo).
// Run: npm run test:mobile-view.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { gameVitePlugins, loadActiveGame, viteGameConfig } from '../scripts/lib/active-game.mjs';
import { connect, launchChrome } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const active = loadActiveGame(ROOT), g = viteGameConfig(active);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEV_UI = '#tuning, #dbg, #tune-toggle, #dbg-toggle, #mobile-view-bar, .mbtn.dev';

const server = await createServer({ configFile: false, root: ROOT, publicDir: g.publicDir, logLevel: 'error',
  plugins: [...g.plugins, ...await gameVitePlugins(active, { command: 'serve', mode: 'development' })], resolve: { alias: [
    { find: /^@game$/, replacement: join(ROOT, 'tests/fixtures/frontend-game.ts') }, // (it has a touch button)
    { find: '@fixture-base-game', replacement: join(active.abs, 'src/index.ts') },
    ...g.resolve.alias,
  ] }, define: { ...g.define, 'import.meta.env.VITE_PLATFORM': JSON.stringify('web') },
  server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const chrome = await launchChrome({ width: 1400, height: 900 });
let cdp;
try {
  cdp = await connect(chrome.wsUrl);
  const problems = [];
  const open = async targetId => {
    const p = await cdp.attach(targetId);
    p.on(m => {
      if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    });
    for (const d of ['Runtime', 'Page']) await p.S(`${d}.enable`);
    await p.S('Emulation.setFocusEmulationEnabled', { enabled: true }); // (both windows keep playing; focus is not under test)
    return p;
  };
  const click = async (p, sel) => {
    const [x, y] = await p.evalJS(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await p.S('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  };
  const [first] = await cdp.pages();
  const main = await open(first.targetId);
  await main.S('Page.navigate', { url: `${base}?autostart` });
  await main.waitFor("window.__game?.phase?.() === 'playing' && !!document.querySelector('#mobile-view-toggle')", 60000, 'the main window in play, with the Mobile view button');
  assert.equal(await main.evalJS("document.body.classList.contains('touch-controls')"), false, 'a desktop window is not marked for touch');
  assert.equal(await main.evalJS("document.querySelector('.touch-btns').hidden"), true, 'a desktop window shows no touch buttons');
  assert.equal(await main.evalJS('document.querySelector("#mobile-view-rotate").hidden'), true, 'Rotate shows only while the view is open');

  await main.evalJS('(() => { const open = window.open.bind(window); window.open = (...a) => ((window.__opened = a), open(...a)); })()');
  await click(main, '#mobile-view-toggle');
  const [url, name, features] = await main.evalJS('window.__opened');
  assert.ok(new URL(url).searchParams.has('autostart') && name === 'vgd-mobile-view', `opens this page in play, as the view: ${url} ${name}`);
  assert.match(features, /^popup=yes,width=844,height=390,left=\d+,top=\d+,resizable=yes$/, 'asks for a landscape phone-sized window');
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    target = (await cdp.pages()).find(t => t.targetId !== first.targetId);
    if (!target) await sleep(100);
  }
  assert.ok(target, 'the button opens a window');
  const view = await open(target.targetId);
  const ready = label => view.waitFor("window.__game?.phase?.() === 'playing' && document.body.classList.contains('touch-controls') && !document.querySelector('.touch-btns').hidden", 60000, label);
  await ready('the view in play (the main window was), marked for touch, with its touch buttons');
  const state = () => view.evalJS(`({ name: window.name, mobileView: __game.runtime.mobileView, emulate: __game.runtime.input.emulateTouch, devUi: document.querySelectorAll(${JSON.stringify(DEV_UI)}).length })`);
  assert.deepEqual(await state(), { name: 'vgd-mobile-view', mobileView: true, emulate: true, devUi: 0 }, 'the view: the mouse as a finger and no dev panels');
  assert.equal(await main.evalJS("document.querySelector('#mobile-view-toggle').getAttribute('aria-pressed')"), 'true', 'the button shows the view is open');

  // A left-button drag on the play area is a finger on the move stick.
  await view.S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 300, button: 'left', buttons: 1, clickCount: 1 });
  await view.S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 240, button: 'left', buttons: 1 });
  assert.ok(await view.evalJS('!!__game.runtime.input.touchStick'), 'a mouse drag drives the move stick');
  await view.S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 240, button: 'left', buttons: 0, clickCount: 1 });
  assert.ok(await view.evalJS('!__game.runtime.input.touchStick'), 'letting go ends it');

  // The window name keeps it a Mobile view through a reload (the game's own links too).
  await view.S('Page.reload');
  await sleep(300);
  await ready('the view after a reload');
  assert.equal((await state()).mobileView, true, 'still the Mobile view after a reload');

  await view.evalJS('(() => { const resize = window.resizeTo.bind(window); window.resizeTo = (w, h) => ((window.__resized = [w - (outerWidth - innerWidth), h - (outerHeight - innerHeight)]), resize(w, h)); })()');
  await click(main, '#mobile-view-rotate');
  await view.waitFor('!!window.__resized', 5000, 'Rotate resizes the view');
  assert.deepEqual(await view.evalJS('window.__resized'), [390, 844], 'Rotate asks for a portrait phone viewport');

  await click(main, '#mobile-view-toggle');
  for (let i = 0; i < 50 && (await cdp.pages()).some(t => t.targetId === target.targetId); i++) await sleep(100);
  assert.ok(!(await cdp.pages()).some(t => t.targetId === target.targetId), 'the button closes the view');
  await main.waitFor("document.querySelector('#mobile-view-toggle').getAttribute('aria-pressed') === 'false' && document.querySelector('#mobile-view-rotate').hidden", 5000, 'the button shows the view closed');

  // ?mobileView makes any window one: an agent's phone-sized browser, say.
  await main.S('Page.navigate', { url: `${base}?mobileView&autostart` });
  await main.waitFor("window.__game?.phase?.() === 'playing' && __game.runtime.mobileView && document.body.classList.contains('touch-controls')", 60000, '?mobileView');
  assert.equal(await main.evalJS(`document.querySelectorAll(${JSON.stringify(DEV_UI)}).length`), 0, '?mobileView shows no dev panels');

  assert.deepEqual(problems, [], 'no page errors');
  console.log('mobile view OK: opens in play, touch layout and buttons, mouse as a finger, no dev panels, survives a reload, rotates, closes; ?mobileView');
} finally {
  cdp?.close();
  await chrome.close();
  await server.close();
}
