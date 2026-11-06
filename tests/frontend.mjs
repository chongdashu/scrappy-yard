#!/usr/bin/env node
// Real CDP input against a production-built fixture around the active game.
// Synthetic wins test shell transitions, not the game's mechanics. Never shipped.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { gameVitePlugins, loadActiveGame, viteGameConfig } from '../scripts/lib/active-game.mjs';
import { connect, launchChrome } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const active = loadActiveGame(ROOT), g = viteGameConfig(active);
const OUT = join(ROOT, 'out/frontend', active.manifest.id);
const buildDir = join(OUT, 'build');
const sizes = [[907,510],[1216,684],[1077,606],[821,462],[1366,768],[1920,1080],[1536,864],[1280,720],[800,450],[1080,607]];
// Dated portal matrix (2026-10-02); update from official gameplay requirements.
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// Overlay layout: at every host size, each visible HUD box fits the viewport and overlaps no other. The boxes are what the engine lays
// out (the game's pieces in the top bar, the mute/pause buttons, the touch buttons) plus any element the game marks `data-no-overlap`
// (a notice, a chat panel, a status cluster). One element inside another is not an overlap. A modal card (pause, results) covers the
// HUD on purpose, so it is checked on its own: it must fit the viewport, buttons included.
const HUD_BOXES = '#hud-game-top > *, #hud-top .hud-buttons, .touch-btn, [data-no-overlap]';
const CARD_BOXES = '.popup:not([hidden]) > .pcard, .popup:not([hidden]) .row-buttons button';
const touchSizes = [[390,844],[844,390],[667,375]]; // phone portrait and landscape, and a short one (DPR 1 like the rest)
const layoutProblems = (sel, pairs) => `(() => {
  const shown = e => { if (e.closest('[hidden]') || !e.getClientRects().length) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && +cs.opacity > 0; };
  const name = e => e.id ? '#' + e.id : e.dataset.action ? '[data-action="' + e.dataset.action + '"]' : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : '');
  const boxes = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(shown).map(e => ({ e, name: name(e), r: e.getBoundingClientRect() })).filter(b => b.r.width > 0 && b.r.height > 0);
  const out = [], px = n => Math.round(n);
  for (const b of boxes) if (b.r.left < -1 || b.r.top < -1 || b.r.right > innerWidth + 1 || b.r.bottom > innerHeight + 1) out.push(b.name + ' leaves the viewport (' + px(b.r.left) + ',' + px(b.r.top) + ' to ' + px(b.r.right) + ',' + px(b.r.bottom) + ')');
  if (${pairs}) for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 1 && h > 1) out.push(a.name + ' overlaps ' + b.name + ' (' + px(w) + 'x' + px(h) + ' px)');
  }
  return out;
})()`;
/** Every host size in turn: the HUD layer pairwise, or the open card alone. Returns to the session's own size. */
async function checkLayout(p, size, hostSizes, home, what, shot, tag = what) {
  const problems = [];
  if (what === 'hud') {
    // The check checks itself: a box a game marks data-no-overlap, put over the pause button, must be reported (or every run passes unseen).
    const caught = await p.evalJS(`(() => { const r = document.querySelector('#btn-pause').getBoundingClientRect(), e = document.createElement('div');
      e.id = 'layout-self-test'; e.dataset.noOverlap = ''; Object.assign(e.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      document.body.append(e); const out = ${layoutProblems(HUD_BOXES, true)}; e.remove(); return out; })()`);
    assert.ok(caught.some(x => x.includes('#layout-self-test overlaps') || x.includes('overlaps #layout-self-test')), `the layout check catches a marked box over the pause button: ${JSON.stringify(caught)}`);
  }
  for (const [w,h] of hostSizes) {
    await size(w,h); await sleep(120); // the resize, then a frame for the HUD and the touch layer to lay out again
    for (const x of await p.evalJS(layoutProblems(what === 'hud' ? HUD_BOXES : CARD_BOXES, what === 'hud'))) problems.push(`${w}x${h}: ${x}`);
  }
  const [w,h] = hostSizes.reduce((a,b) => b[0]*b[1] < a[0]*a[1] ? b : a);
  await size(w,h); await sleep(120); await shot(`layout-${tag}-${w}x${h}`);
  await size(...home); await sleep(120);
  return problems;
}
await build({ configFile: false, root: ROOT, base: './', publicDir: g.publicDir,
  plugins: [...g.plugins, ...await gameVitePlugins(active, { command: 'build', mode: 'production' })], resolve: { alias: [
    { find: /^@game$/, replacement: join(ROOT, 'tests/fixtures/frontend-game.ts') },
    { find: '@fixture-base-game', replacement: join(active.abs, 'src/index.ts') },
    ...g.resolve.alias,
  ] }, define: { ...g.define, 'import.meta.env.VITE_PLATFORM': JSON.stringify('web') },
  build: { target: 'es2022', outDir: buildDir, emptyOutDir: true, rollupOptions: { input: join(ROOT, 'index.html') } },
});
const server = await preview({ configFile: false, root: ROOT, build: { outDir: buildDir }, preview: { host: '127.0.0.1', port: 0 },
  plugins: await gameVitePlugins(active, { command: 'serve', mode: 'production', isPreview: true }) });
const base = server.resolvedUrls.local[0];
try {
  for (const renderer of ['webgpu','webgl2']) for (const touch of [false,true]) {
    if (process.argv.includes('--only=phone') && !touch) continue;
    const chrome = await launchChrome({ width:1280, height:720 });
    let cdp;
    try {
      cdp = await connect(chrome.wsUrl);
      const [target] = await cdp.pages();
      const p = await cdp.attach(target.targetId), problems = [];
      p.on(m => {
        if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map(a => a.value ?? a.description).join(' '));
      });
      for (const d of ['Runtime','Page']) await p.S(`${d}.enable`);
      await p.S('Emulation.setFocusEmulationEnabled', { enabled:true });
      await p.S('Page.bringToFront');
      await cdp.send('Target.activateTarget', { targetId:target.targetId });
      const size = async (width,height) => p.S('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:touch });
      await size(touch ? 390 : 1280,touch ? 844 : 720);
      if (touch) await p.S('Emulation.setTouchEmulationEnabled', { enabled:true,maxTouchPoints:5 });
      await p.S('Page.navigate', { url:`${base}?renderer=${renderer}` });
      const wait = (expr, label=expr) => p.waitFor(expr,10000,label);
      const phase = value => wait(`window.__game.phase() === '${value}'`, value);
      // A click that starts a round at once (Restart round, Play again) also reaches the fixture's window click listener, which
      // skips its intro: the countdown then lasts one frame, too short to poll for. Watch the phase attribute across such a click.
      const watchStart = () => p.evalJS(`window.__startSeen=[]; window.__startObs?.disconnect(); window.__startObs=new MutationObserver(()=>__startSeen.push(document.body.dataset.phase)); __startObs.observe(document.body,{attributes:true,attributeFilter:['data-phase']}); 0`);
      const started = value => wait(`window.__startSeen.includes('${value}')`, `${value} after the click`);
      const state = () => p.evalJS('window.__game.stats()');
      const locked = () => p.evalJS('!!document.pointerLockElement');
      const center = sel => p.evalJS(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]; })()`);
      const move = (x,y) => p.S('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      const click = async target => {
        const [x,y] = Array.isArray(target) ? target : await center(target);
        if (touch) {
          await p.S('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
          await p.S('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        } else {
          await move(x,y);
          for (const type of ['mousePressed','mouseReleased']) await p.S('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
        }
      };
      const key = async (code,vk) => {
        for (const type of ['keyDown','keyUp']) await p.S('Input.dispatchKeyEvent',{type,code,key:code,windowsVirtualKeyCode:vk});
      };
      const shot = async label => {
        const {data} = await p.S('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(OUT,`${renderer}-${touch?'phone':'desktop'}-${label}.png`),Buffer.from(data,'base64'));
      };
      const fits = async sel => {
        const failures = await p.evalJS(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter(e => !e.closest('[hidden]') && getComputedStyle(e).display !== 'none').flatMap(e => { const r=e.getBoundingClientRect(); return r.width && r.height && (r.left < -1 || r.top < -1 || r.right > innerWidth+1 || r.bottom > innerHeight+1) ? [e.id || e.textContent] : []; })`);
        assert.deepEqual(failures,[],`visible controls fit ${sel}`);
      };
      await wait('!!window.__game && !document.querySelector("#press-start").hidden');
      await click('#press-start'); await phase('menu'); await sleep(600);
      if (!touch) {
        for (const [w,h] of sizes) { await size(w,h); await sleep(50); await fits('#menu button'); }
        await size(907,510); await shot('portal-menu'); await size(1280,720);
        // The game's own popups (menu.extra) replace "How to play" (help: false), on the menu and the pause card.
        assert.equal(await p.evalJS(`[...document.querySelectorAll('#menu .mbtn')].filter(b => !b.hidden).map(b => b.dataset.act).join()`),'play,settings,extra:about,extra:credits','menu entries');
        assert.equal(await p.evalJS(`document.querySelector('#pause-help').hidden && !!document.querySelector('#pause-extra-about') && !document.querySelector('#pause-extra-credits')`),true,'pause card entries');
        assert.equal(await p.evalJS(`document.querySelector('#extra-credits-title').textContent`),'Credits <&> "quotes"','plain-text titles are escaped');
        await click('.mbtn[data-act="extra:credits"]'); await wait(`!document.querySelector('#extra-credits-pop').hidden && document.activeElement?.textContent === 'Done'`,'credits popup');
        await key('Escape',27); await wait(`document.querySelector('#extra-credits-pop').hidden && document.activeElement?.dataset.act === 'extra:credits'`,'credits closed, focus back on its menu button');
        await sleep(300);
      }
      await click('.mbtn[data-act="play"]'); await phase('countdown');
      if (!touch) {
        await wait('!!document.pointerLockElement');
        assert.equal((await state()).yaw,0,'look neutral during intro');
        await p.evalJS(`window.__lockSamples=[]; window.__lockTimer=setInterval(()=>window.__lockSamples.push(!!document.pointerLockElement),10)`);
      }
      await phase('playing');
      if (!touch) {
        const samples = await p.evalJS('clearInterval(window.__lockTimer); window.__lockSamples');
        assert.ok(samples.length && samples.every(Boolean),'capture survives setup');
        for (let k=1;k<=5;k++) { await move(640+k*20,360); await sleep(20); }
        assert.ok(Math.abs((await state()).yaw)>0.01,'real mouse look at GO');
        // pauseOnBlur "input": alt-tab (focus lost, then the capture released) keeps the round running with input withheld.
        const steps0 = await p.evalJS('window.__game.simSteps()');
        await p.evalJS(`document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); 0`);
        await wait('!document.pointerLockElement', 'blur released the capture'); await sleep(300);
        assert.equal(await p.evalJS('window.__game.phase()'),'playing','blur under pauseOnBlur "input" does not pause');
        assert.equal(await p.evalJS('window.__game.runtime.inputSuspended'),true,'input withheld while away');
        assert.ok(await p.evalJS('window.__game.simSteps()') > steps0,'the sim keeps running while away');
        await p.evalJS(`delete document.hasFocus; window.dispatchEvent(new Event('focus')); 0`);
        assert.equal(await p.evalJS('window.__game.runtime.inputSuspended'),false,'input restored with focus');
        await click([740,360]); await wait('!!document.pointerLockElement','the next click captures again');
        await click([740,360]); // also catches setPointerCapture while locked
      } else {
        assert.equal(await locked(),false,'a touch menu gesture never requests mouse lock');
        await wait(`document.querySelector('[data-action="use"]').getBoundingClientRect().width > 0`);
        await p.evalJS(`window.__ptr=[]; for(const type of ['pointerdown','pointermove','pointercancel']) document.addEventListener(type,e=>window.__ptr.push([type,e.pointerId,e.pointerType,e.target.id||e.target.className,e.clientX,e.clientY]),true)`);
        const [bx,by] = await center('[data-action="use"]');
        const points = [{id:1,x:65,y:650},{id:2,x:250,y:350},{id:3,x:bx,y:by}];
        await p.S('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});
        points[0].y-=40; points[1].x+=35;
        await p.S('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points});
        await sleep(200);
        const s=await state(); assert.ok(s.moved>0 && s.looked>0 && s.used>0,`simultaneous touch move/look/action: ${JSON.stringify(s)}; events ${JSON.stringify(await p.evalJS("window.__ptr"))}`);
        await p.S('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }
      await phase('results'); await sleep(350);
      assert.equal(await locked(),false,'results releases lock');
      assert.equal(await p.evalJS('document.querySelector("#results-again").hidden'),true);
      assert.equal(await p.evalJS('document.activeElement.id'),'results-menu');
      assert.ok(await p.evalJS('document.querySelector("#results-custom h2").getBoundingClientRect().width > 10'), 'custom headings remain visible');
      await fits('#results-pop button'); await shot('custom-results');
      if (!touch) {
        // A results-card button opens a game popup through rt.openPopup; closing it returns to the card, not the menu.
        await click('#results-about'); await wait(`!document.querySelector('#extra-about-pop').hidden && document.querySelector('#results-pop').hidden`,'about over results');
        await sleep(300); await key('Escape',27);
        await wait(`!document.querySelector('#results-pop').hidden && document.querySelector('#extra-about-pop').hidden`,'back to the results card');
        assert.equal(await p.evalJS('window.__game.phase()'),'results','still on the results');
        await sleep(450);
      }
      await key('Escape',27); await phase('menu'); await sleep(600);
      await click('.mbtn[data-act="play"]'); await phase('countdown');
      await sleep(200); await click([200,200]); await phase('playing'); // skip intro while locked
      if (!touch) {
        assert.equal(await locked(),true,'skip preserves lock');
        await p.evalJS('document.exitPointerLock()'); await phase('paused'); await sleep(350);
        // The pause card's game entry opens over it and comes back to it, still paused.
        await click('#pause-extra-about'); await wait(`!document.querySelector('#extra-about-pop').hidden`,'about from pause'); await sleep(300);
        await key('Escape',27); await wait(`!document.querySelector('#pause-pop').hidden && document.querySelector('#extra-about-pop').hidden`,'back to the pause card');
        assert.equal(await p.evalJS('window.__game.phase()'),'paused','closing it does not resume');
        await sleep(350);
        await click('#pause-resume'); await phase('playing'); await wait('!!document.pointerLockElement'); await sleep(80);
        // rt.openPopup in play pauses first and opens over the pause card.
        assert.equal(await p.evalJS(`window.__game.runtime.openPopup('about')`),true,'openPopup in play');
        await phase('paused'); await wait(`!document.querySelector('#extra-about-pop').hidden`,'about over the pause card'); await sleep(300);
        await key('Escape',27); await wait(`!document.querySelector('#pause-pop').hidden`,'pause card again'); await sleep(350);
        assert.equal(await p.evalJS(`window.__game.runtime.openPopup('nope')`),false,'unknown popup id');
        await click('#pause-resume'); await phase('playing'); await wait('!!document.pointerLockElement'); await sleep(80);
        await p.evalJS('document.exitPointerLock()'); await phase('paused'); await sleep(350);
        await watchStart(); await click('#pause-restart'); await started('countdown'); await wait('!!document.pointerLockElement');
        await phase('playing');
        await click([640,360]);
      } else await click('[data-action="use"]');
      await phase('results'); await sleep(350);
      assert.equal(await p.evalJS('document.querySelector("#results-custom").childElementCount'),0,'plain results clear custom content');
      assert.equal(await p.evalJS('document.querySelector("#results-again").hidden'),false,'default replay restored');
      await watchStart(); await click('#results-again'); await started('countdown'); await phase('playing');
      if (!touch) {
        // Escape with focus off the card's buttons (a click on its ribbon) resumes once: the handled key must not pause again next frame.
        await wait('!!document.pointerLockElement'); await p.evalJS('document.exitPointerLock()'); await phase('paused'); await sleep(350);
        await click('#pause-title'); await sleep(100);
        await p.evalJS(`window.__phases=[]; window.__phaseObs=new MutationObserver(()=>__phases.push(document.body.dataset.phase)); __phaseObs.observe(document.body,{attributes:true,attributeFilter:['data-phase']}); 0`);
        await key('Escape',27); await phase('playing'); await sleep(300);
        assert.deepEqual(await p.evalJS('__phaseObs.disconnect(), __phases'),['playing'],'one Escape on the pause card resumes and stays resumed');
        await wait('!!document.pointerLockElement'); await sleep(80);
      }
      await click(touch ? '[data-action="use"]' : [640,360]);
      await phase('results'); await sleep(350);
      await key('Backspace',8); await phase('menu'); await sleep(600);
      // Game.skipCountdown: Play goes straight to playing (no countdown phase, number or intro), with control at once.
      await p.evalJS('window.__game.setSkipCountdown(true)');
      await p.evalJS(`window.__phases=[]; window.__phaseObs=new MutationObserver(()=>__phases.push(document.body.dataset.phase)); __phaseObs.observe(document.body,{attributes:true,attributeFilter:['data-phase']}); 0`);
      await click('.mbtn[data-act="play"]'); await phase('playing');
      assert.deepEqual(await p.evalJS('__phaseObs.disconnect(), __phases'),['playing'],'skipCountdown: menu → playing with no countdown');
      assert.equal(await p.evalJS('document.querySelector("#countdown").hidden'),true,'skipCountdown: no number on screen');
      assert.equal((await state()).intro,0,'skipCountdown: no intro');
      assert.equal(await p.evalJS('window.__game.runtime.input.gameplay'),true,'skipCountdown: control at once');
      if (!touch) {
        await wait('!!document.pointerLockElement','skipCountdown: the Play click captured the mouse');
        // The focus policy changes mid-game (rt.setPauseOnBlur): from the fixture's "input" to "pause", then "none".
        assert.equal(await p.evalJS('window.__game.pauseOnBlur()'),'input','GameModule.pauseOnBlur reached the runtime');
        await p.evalJS(`window.__game.runtime.setPauseOnBlur('pause'); window.dispatchEvent(new Event('blur')); 0`);
        await phase('paused');
        assert.equal(await p.evalJS('window.__game.pauseOnBlur()'),'pause','setPauseOnBlur("pause") took effect');
        await sleep(350); await click('#pause-resume'); await phase('playing');
        const steps1 = await p.evalJS('window.__game.simSteps()');
        // (A real focus loss: with the page still focused, losing the capture reads as Esc and pauses in every mode.)
        await p.evalJS(`window.__game.runtime.setPauseOnBlur('none'); document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); 0`); await sleep(300);
        assert.equal(await p.evalJS('window.__game.phase()'),'playing','"none": blur leaves the round running');
        assert.equal(await p.evalJS('window.__game.runtime.inputSuspended'),false,'"none": input is not withheld');
        assert.ok(await p.evalJS('window.__game.simSteps()') > steps1,'"none": the sim keeps running');
        await p.evalJS(`delete document.hasFocus; window.dispatchEvent(new Event('focus')); 0`);
      }
      // Overlay layout at every host size: in play (the HUD layer), on the pause card and on the results card.
      {
        const hostSizes = touch ? touchSizes : sizes, home = touch ? [390,844] : [1280,720], layout = [];
        await phase('playing');
        layout.push(...await checkLayout(p, size, hostSizes, home, 'hud', shot));
        if (!touch && await locked()) await p.evalJS('document.exitPointerLock()'); else await click('#btn-pause');
        await phase('paused'); await sleep(400); // the card's opening tween scales it
        layout.push(...(await checkLayout(p, size, hostSizes, home, 'card', shot, 'pause')).map(x => `pause card ${x}`));
        await click('#pause-resume'); await phase('playing'); await sleep(400); // the card's closing tween still covers the screen
        if (!touch) { await wait('!!document.pointerLockElement','resume captured the mouse'); await sleep(80); }
        await click(touch ? '[data-action="use"]' : [640,360]); await phase('results'); await sleep(400);
        layout.push(...(await checkLayout(p, size, hostSizes, home, 'card', shot, 'results')).map(x => `results card ${x}`));
        assert.deepEqual(layout,[],'HUD boxes fit and do not overlap; cards fit, at every host size');
      }
      assert.deepEqual(problems,[],'no exceptions or console errors');
      console.log(`[frontend] ${renderer} ${touch?'touch':'desktop'}: PASS`);
    } finally { cdp?.close(); await chrome.close(); }
  }
  if (!process.argv.includes('--only=phone')) for (const renderer of ['webgpu','webgl2']) await startPasses(renderer);
} finally { await new Promise(r=>server.httpServer.close(r)); }

/**
 * The ready screen and the two start transitions on one renderer, desktop: `#boot.is-ready`; the wipe (the default) and
 * GameModule.startTransition "cut" (the fixture's `?start=cut`: no wipe, the menu at once, the camera carried on, a long
 * title still centred). On the cut pass, rt.captureFrame (a copy of the rendered frame), rt.returnToMenu (out of play
 * with no wipe), a game modal that owns Escape by handling it on `document` first, and a menu.extra link (`href`).
 */
async function startPasses(renderer) {
  const chrome = await launchChrome({ width:1280, height:720 });
  let cdp;
  try {
    cdp = await connect(chrome.wsUrl);
    const [target] = await cdp.pages();
    const p = await cdp.attach(target.targetId), problems = [];
    p.on(m => {
      if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    });
    for (const d of ['Runtime','Page']) await p.S(`${d}.enable`);
    await p.S('Emulation.setFocusEmulationEnabled', { enabled:true });
    await p.S('Page.bringToFront');
    const size = (width,height) => p.S('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false });
    const wait = (expr, label=expr) => p.waitFor(expr,10000,label);
    const click = async sel => {
      const [x,y] = await p.evalJS(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]; })()`);
      await p.S('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      for (const type of ['mousePressed','mouseReleased']) await p.S('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
    };
    for (const start of ['wipe','cut']) {
      const name = `${renderer} ${start} start`;
      await size(1280,720);
      await p.S('Page.navigate', { url:`${base}?renderer=${renderer}${start === 'cut' ? '&start=cut&link' : ''}` });
      await wait('!!window.__game && !document.querySelector("#press-start").hidden', `${name}: ready screen`);
      assert.equal(await p.evalJS(`document.querySelector('#boot').classList.contains('is-ready')`), true, `${name}: #boot.is-ready`);
      if (start === 'cut') {
        // A title too long for the column overflows evenly: the column, the title and the start button stay centred.
        const title = await p.evalJS(`(() => { const t = document.querySelector('#boot .logo'), was = t.textContent; t.textContent = 'Supercalifragilisticexpialidocious'; return was; })()`);
        for (const [w,h] of [[1920,1080],[1280,720],[390,844],[667,375]]) {
          await size(w,h); await sleep(50);
          const centres = await p.evalJS(`['.boot-col','#boot .logo','#press-start'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return +(r.x + r.width / 2).toFixed(1); })`);
          assert.ok(centres.every(x => Math.abs(x - w / 2) < 2), `${name}: ready screen centred at ${w}x${h} with a long title (${centres})`);
        }
        await p.evalJS(`document.querySelector('#boot .logo').textContent = ${JSON.stringify(title)}`);
        await size(1280,720); await sleep(50);
      }
      // Per frame from before the press: was the wipe shown, how the Play entry looks, where the camera is.
      await p.evalJS(`window.__wipeSeen = false;
        new MutationObserver(() => { if (!document.querySelector('#wipe').hidden) window.__wipeSeen = true; }).observe(document.querySelector('#wipe'), { attributes: true, attributeFilter: ['hidden'] });
        window.__frames = [];
        const sample = () => { const b = document.querySelector('#menu [data-act="play"]'), shown = !document.querySelector('#menu').hidden;
          __frames.push({ phase: __game.phase(), eye: [...__game.runtime.camera.eye], entry: shown ? [getComputedStyle(b).opacity, getComputedStyle(b).transform] : null });
          if (__frames.length < 150) requestAnimationFrame(sample); };
        requestAnimationFrame(sample); 0`);
      await sleep(150);
      await click('#press-start'); await wait(`window.__game.phase() === 'menu'`, `${name}: menu`);
      if (start === 'cut') assert.equal(await p.evalJS(`document.querySelector('#boot').hidden && !document.querySelector('#menu').hidden && +getComputedStyle(document.querySelector('#menu')).opacity > 0.99`), true, `${name}: the loading screen goes and the menu is there at once`);
      await sleep(900);
      assert.equal(await p.evalJS('window.__wipeSeen'), start === 'wipe', `${name}: the wipe ${start === 'wipe' ? 'covers' : 'never shows during'} the swap`);
      const frames = await p.evalJS('window.__frames'), entry = frames.filter(f => f.entry).map(f => f.entry);
      assert.ok(entry.length > 4 && +entry[0][0] < 0.2 && new Set(entry.map(e => e[1])).size > 4, `${name}: the menu entries cascade in (${JSON.stringify(entry.slice(0, 3))})`);
      if (start === 'cut') {
        const swap = frames.findIndex(f => f.phase === 'menu'), around = frames.slice(Math.max(1, swap - 10), swap + 10);
        const jump = Math.max(...around.map((f, i) => Math.hypot(...f.eye.map((v, k) => v - frames[frames.indexOf(f) - 1].eye[k]))));
        assert.ok(swap > 0 && jump < 0.3, `${name}: the camera carries on from the ready screen (largest step ${jump.toFixed(3)} m around the cut)`);
        // rt.captureFrame: a copy of the frame just rendered, the drawing buffer's size, opaque, with the scene in it.
        const cap = await p.evalJS(`(async () => {
          const c = await window.__game.runtime.captureFrame(), g = window.__game.runtime.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let lo = 255, hi = 0, opaque = true;
          for (let i = 0; i < d.length; i += 4 * 97) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; lo = Math.min(lo, l); hi = Math.max(hi, l); if (d[i + 3] !== 255) opaque = false; }
          return { size: [c.width, c.height], canvas: [g.width, g.height], copy: c !== g, lo, hi, opaque };
        })()`);
        assert.ok(cap.copy && cap.size.join() === cap.canvas.join() && cap.size[0] > 0, `${name}: captureFrame copies the drawing buffer (${cap.size} for ${cap.canvas})`);
        assert.ok(cap.opaque && cap.hi - cap.lo > 30, `${name}: the copy holds the rendered scene (luma ${cap.lo}..${cap.hi}, opaque ${cap.opaque})`);
        // rt.returnToMenu: nothing to leave on the menu; from play, the menu at once with a new round and no wipe.
        assert.equal(await p.evalJS('window.__game.runtime.returnToMenu()'), false, `${name}: returnToMenu on the menu`);
        await p.evalJS('window.__game.setSkipCountdown(true)');
        await click('.mbtn[data-act="play"]'); await wait(`window.__game.phase() === 'playing'`, `${name}: playing`);
        await sleep(300);
        await p.evalJS('window.__wipeSeen = false');
        const back = await p.evalJS(`(() => { const rounds = __game.rounds(), ok = __game.runtime.returnToMenu(); return { ok, phase: __game.phase(), rounds: __game.rounds() - rounds, gameplay: __game.runtime.input.gameplay }; })()`);
        assert.deepEqual(back, { ok: true, phase: 'menu', rounds: 1, gameplay: false }, `${name}: returnToMenu leaves play at once with a new round`);
        await sleep(600);
        assert.equal(await p.evalJS(`window.__wipeSeen || !!document.pointerLockElement || document.querySelector('#menu').hidden`), false, `${name}: no wipe, the mouse released, the menu up`);
        // A game modal over the pause card owns Escape by handling it on document (before the engine's window listeners) and
        // calling preventDefault: the modal closes, the pause card stays; the next Escape is the card's again.
        const key = async (code, vk) => { for (const type of ['keyDown','keyUp']) await p.S('Input.dispatchKeyEvent',{type,code,key:code,windowsVirtualKeyCode:vk}); };
        await click('.mbtn[data-act="play"]'); await wait(`window.__game.phase() === 'playing'`, `${name}: playing again`); await sleep(300);
        await p.evalJS('document.exitPointerLock()'); await wait(`window.__game.phase() === 'paused'`, `${name}: paused`); await sleep(400);
        await p.evalJS(`(() => { const m = document.createElement('div'); m.id = 'game-modal'; document.body.append(m);
          document.addEventListener('keydown', (e) => { if (!m.hidden && e.code === 'Escape') { e.preventDefault(); m.hidden = true; } }); })()`);
        await key('Escape', 27); await sleep(300);
        assert.deepEqual(await p.evalJS(`[document.querySelector('#game-modal').hidden, window.__game.phase(), !document.querySelector('#pause-pop').hidden]`), [true, 'paused', true], `${name}: Escape closed the game's modal only`);
        await key('Escape', 27); await wait(`window.__game.phase() === 'playing'`, `${name}: the next Escape resumes`);
        // A menu.extra entry with an href is a link on the menu, laid out like the buttons, and the pointer follows it.
        assert.equal(await p.evalJS(`window.__game.runtime.returnToMenu()`), true);
        await sleep(600);
        const link = await p.evalJS(`(() => { const a = document.querySelector('#menu a.mbtn[data-extra-link="scene"]'), b = document.querySelector('#menu .mbtn[data-act="settings"]');
          return a && { href: a.getAttribute('href'), height: a.offsetHeight, buttonHeight: b.offsetHeight, width: a.offsetWidth, buttonWidth: b.offsetWidth, line: getComputedStyle(a).textDecorationLine }; })()`); // (layout sizes: the entries may still be cascading in)
        assert.ok(link && link.href === '?scene=linked' && link.height === link.buttonHeight && link.width === link.buttonWidth && link.line === 'none', `${name}: the link entry lines up with the buttons (${JSON.stringify(link)})`);
        await click('#menu a.mbtn[data-extra-link="scene"]');
        await wait(`location.search.includes('scene=linked')`, `${name}: the link entry navigates`);
      }
      console.log(`[frontend] ${name}: PASS`);
    }
    assert.deepEqual(problems,[],`${renderer} start passes: no exceptions or console errors`);
  } finally { cdp?.close(); await chrome.close(); }
}
