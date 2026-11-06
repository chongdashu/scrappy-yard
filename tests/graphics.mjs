#!/usr/bin/env node
// Exercise real browser startup failures against the frozen production package.
// npm run test:graphics (or GAME_DIR=addons/starter-arena npm run test:graphics)
// No game state is injected: capture mode advances the normal runtime deterministically.
// The materials scenario then builds tests/fixtures/graphics-game.ts around the active game (BLEND,
// MASK, depth of field, bump relief, cloud tint and opacity) and checks probe pixels on both backends; the textures scenario uses the same
// build for glTF samplers (nearest vs linear, mipmaps or not) and shared texture uploads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { connect, launchChrome } from './lib/cdp.mjs';
import { loadActiveGame, viteGameConfig } from '../scripts/lib/active-game.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const active = loadActiveGame();
const game = active.manifest;
const out = new URL(`../out/graphics/${game.id}/`, import.meta.url);
mkdirSync(out, { recursive: true });
const gpu = (expression) => `Object.defineProperty(navigator, 'gpu', { configurable: true, value: ${expression} });`;
const noAPI = gpu('undefined') + `for (const key of ['GPUBufferUsage','GPUTextureUsage','GPUShaderStage','GPUMapMode']) Object.defineProperty(window,key,{value:undefined,configurable:true});`;
const cases = [
  { name: 'webgpu', mode: 'webgpu', backend: 'webgpu', shot: true },
  { name: 'webgl2', mode: 'webgl2', backend: 'webgl2', script: noAPI, shot: true },
  { name: 'missing-api', reason: 'api-unavailable', script: noAPI },
  { name: 'missing-adapter', reason: 'adapter-unavailable', script: gpu('{requestAdapter: async () => null}') },
  { name: 'stalled-adapter', reason: 'adapter-timeout', script: gpu('{requestAdapter: () => new Promise(() => {})}') },
  { name: 'failed-device', reason: 'device', script: gpu('{requestAdapter: async () => ({requestDevice: async () => {throw new Error("injected device failure")}})}') },
  { name: 'configured-canvas', reason: 'initialization', script: `
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function(...args) {
      configure.apply(this,args); window.originalCanvas = this.canvas;
      throw new Error('injected failure after acquiring WebGPU canvas');
    };`, replaced: true },
  { name: 'pipeline-validation', reason: 'initialization', script: `
    const create = GPUDevice.prototype.createRenderPipeline; let injected = false;
    GPUDevice.prototype.createRenderPipeline = function(descriptor) {
      if (!injected && descriptor.fragment) {
        injected = true; descriptor = {...descriptor, fragment:{...descriptor.fragment, entryPoint:'missing_injected_entry_point'}};
      }
      return create.call(this,descriptor);
    };` },
  { name: 'webgl2-rgba8', mode: 'webgl2', backend: 'webgl2', hdr: false, shot: true, script: noAPI + `
    const ext = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function(name) {return name === 'EXT_color_buffer_float' ? null : ext.call(this,name)};` },
  { name: 'float-framebuffer-unavailable', mode: 'webgl2', backend: 'webgl2', hdr: false, script: `
    const check = WebGL2RenderingContext.prototype.checkFramebufferStatus; let first = true;
    WebGL2RenderingContext.prototype.checkFramebufferStatus = function(target) {
      if (first) { first = false; return this.FRAMEBUFFER_UNSUPPORTED; }
      return check.call(this,target);
    };` },
  { name: 'neither-backend', fatal: /Graphics could not start.*WebGL 2.*api-unavailable/s, script: noAPI + `
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type,...args) {return type === 'webgl2' ? null : get.call(this,type,...args)};` },
  { name: 'forced-webgpu-unavailable', mode: 'webgpu', fatal: /Graphics could not start.*WebGPU could not start/s, script: noAPI },
  { name: 'webgl2-context-loss', mode: 'webgl2', backend: 'webgl2', lose: true },
];
const receipts = [];
let server, chrome, cdp;
try {
  if (!process.argv.includes('--no-package')) await new Promise((resolve,reject) => {
    const p = spawn(process.execPath,['scripts/package-web.mjs'],{cwd:root,stdio:'inherit'});
    p.on('error',reject); p.on('exit',code=>code === 0 ? resolve() : reject(new Error(`package exited ${code}`)));
  });
  const manifest = JSON.parse(readFileSync(new URL('../release/web-manifest.json', import.meta.url)));
  const port = await new Promise(resolve => { const s=createServer(); s.listen(0,'127.0.0.1',()=> { const port=s.address().port; s.close(()=>resolve(port)); }); });
  server=spawn(process.execPath,['scripts/serve-release.mjs','web','--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=> {
    const timer=setTimeout(()=>reject(new Error('release server timeout')),15000);
    server.stdout.on('data',d=>{if(String(d).includes('/builds/')){clearTimeout(timer);resolve();}});
    server.on('error',reject); server.on('exit',code=>reject(new Error(`server exited ${code}`)));
  });
  const base=`http://127.0.0.1:${port}/builds/${game.id}/`;
  chrome=await launchChrome(); cdp=await connect(chrome.wsUrl);
  for (const test of cases) {
    const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
    const p=await cdp.attach(targetId), errors=[], requests=[];
    p.on(m=> {
      if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if(m.method==='Runtime.consoleAPICalled' && ['error','assert'].includes(m.params.type)) errors.push(m.params.args.map(a=>a.value ?? a.description).join(' '));
      if(m.method==='Log.entryAdded' && m.params.entry.level==='error') errors.push(m.params.entry.text);
      if(m.method==='Network.requestWillBeSent') requests.push(m.params.request.url);
    });
    await p.S('Runtime.enable'); await p.S('Page.enable'); await p.S('Log.enable'); await p.S('Network.enable');
    await p.S('Emulation.setFocusEmulationEnabled',{enabled:true});
    await p.S('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
    if(test.script) await p.S('Page.addScriptToEvaluateOnNewDocument',{source:test.script});
    await p.S('Page.navigate',{url:`${base}?capture&autostart&nolock&seed=7&renderer=${test.mode ?? 'auto'}`});
    await p.waitFor(`!!window.__game || document.querySelector('#fatal')?.hidden === false`,30000,test.name);
    if(test.fatal) {
      assert.equal(await p.evalJS('!!window.__game'),false);
      const message=await p.evalJS("document.querySelector('#fatal').innerText");
      assert.match(message,test.fatal);
      assert.equal(errors.filter(e=>e.startsWith('[fatal]')).length,1);
      assert.deepEqual(errors.filter(e=>!e.startsWith('[fatal]')),[]);
      receipts.push({name:test.name,fatal:message});
    } else {
      assert.equal(await p.evalJS('!!window.__game'),true,`${test.name}: ${errors.join('\n')}`);
      const info=await p.evalJS('__game.graphics()');
      assert.equal(info.backend,test.backend ?? 'webgl2');
      assert.equal(info.fallbackReason,test.reason ?? null);
      if(test.hdr !== undefined) { assert.equal(info.hdr,test.hdr); assert.equal(info.bloom,test.hdr); }
      if(test.mode==='webgl2') assert.equal(requests.some(url=>/webgpu-(renderer|model)/.test(url)),false,'forced WebGL must not load the WebGPU chunk');
      await p.evalJS('__game.step(240)');
      assert.equal(await p.evalJS('__game.phase()'),'playing');
      if(test.replaced) assert.equal(await p.evalJS('!originalCanvas.isConnected && __game.runtime.canvas !== originalCanvas && __game.runtime.canvas === document.querySelector("canvas")'),true);
      // Trusted pointer input must reach the selected (possibly replaced) canvas.
      await p.S('Input.dispatchMouseEvent',{type:'mousePressed',x:640,y:500,button:'left',clickCount:1});
      assert.equal(await p.evalJS('__game.runtime.input.poll().pointer.down'),true);
      await p.S('Input.dispatchMouseEvent',{type:'mouseReleased',x:640,y:500,button:'left',clickCount:1});
      if(test.shot) {
        await p.S('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
        const {data}=await p.S('Page.captureScreenshot',{format:'png'});
        writeFileSync(new URL(`${test.name}.png`,out),Buffer.from(data,'base64'));
      }
      await p.S('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
      await p.evalJS('__game.step(2)');
      const size=await p.evalJS('__game.runtime.renderer.pixelSize');
      assert.ok(size[0]>0 && size[1]>size[0],'portrait resize');
      assert.equal(await p.evalJS('document.querySelector("#fatal").hidden'),true);
      if(info.backend==='webgl2') assert.equal(await p.evalJS('__game.runtime.renderer.gl.getError()'),0);
      if(test.lose) {
        const steps=await p.evalJS('__game.simSteps()');
        await p.evalJS('__game.runtime.renderer.gl.getExtension("WEBGL_lose_context").loseContext()');
        await p.waitFor('!document.querySelector("#fatal").hidden',5000,'context loss card');
        assert.match(await p.evalJS('document.querySelector("#fatal").innerText'),/graphics device was lost.*Reload/s);
        await p.evalJS('__game.step(2).catch(() => null)');
        assert.equal(await p.evalJS('__game.simSteps()'),steps,'loss stops simulation');
        assert.equal(errors.filter(e=>e.startsWith('[fatal]')).length,1);
      }
      assert.deepEqual(errors.filter(e=>!(test.lose && e.startsWith('[fatal]'))),[],test.name);
      receipts.push({name:test.name,...info,portraitSize:size,input:true,errors:errors.length});
    }
    console.log(`[graphics] ok ${test.name}`);
    await cdp.send('Target.closeTarget',{targetId});
  }
  // Capture resolution: 1440p at DPR 2 is over the phone-sized pixel budget; ?capture&maxpx lifts it, __game.pixelBudget changes it live.
  for (const mode of ['webgpu','webgl2']) {
    const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
    const p=await cdp.attach(targetId), errors=[];
    p.on(m=> {
      if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if(m.method==='Runtime.consoleAPICalled' && ['error','assert'].includes(m.params.type)) errors.push(m.params.args.map(a=>a.value ?? a.description).join(' '));
    });
    await p.S('Runtime.enable'); await p.S('Page.enable');
    await p.S('Emulation.setFocusEmulationEnabled',{enabled:true});
    await p.S('Emulation.setDeviceMetricsOverride',{width:2560,height:1440,deviceScaleFactor:2,mobile:false});
    await p.S('Page.navigate',{url:`${base}?capture&autostart&nolock&seed=7&renderer=${mode}&maxpx=5120x2880`});
    await p.waitFor('!!window.__game',30000,`capture-budget-${mode}`);
    assert.equal((await p.evalJS('__game.graphics()')).backend,mode);
    await p.evalJS('__game.step(2)');
    const full=await p.evalJS('__game.runtime.renderer.pixelSize');
    assert.deepEqual(full,[5120,2880],`${mode}: ?capture&maxpx=5120x2880 renders 1440p at DPR 2 in full`);
    const budget=await p.evalJS('__game.pixelBudget({ maxPixels: 2600000 })');
    assert.equal(budget.maxPixels,2600000);
    await p.evalJS('__game.step(1)');
    const capped=await p.evalJS('__game.runtime.renderer.pixelSize');
    assert.ok(capped[0]*capped[1]<=2600000 && capped[0]<5120,`${mode}: the default budget shrinks it (${capped.join('×')})`);
    assert.deepEqual(errors,[],`capture-budget-${mode}`);
    receipts.push({name:`capture-budget-${mode}`,backend:mode,full,capped});
    console.log(`[graphics] ok capture-budget-${mode} (${full.join('×')}, capped ${capped.join('×')})`);
    await cdp.send('Target.closeTarget',{targetId});
  }
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/__misses`)).json(),[]);
  if (!process.argv.includes('--no-materials')) await materials(cdp, noAPI, receipts);
  writeFileSync(new URL('receipt.json',out),JSON.stringify({at:new Date().toISOString(),browser:await cdp.send('Browser.getVersion'),manifest,cases:receipts},null,2)+'\n');
  console.log(`[graphics] all ${receipts.length} scenarios passed; captures in ${fileURLToPath(out)}`);
} finally {
  cdp?.close(); await chrome?.close(); server?.kill('SIGTERM');
  server?.stdout.destroy(); server?.stderr.destroy();
}

/**
 * Materials: a production build of tests/fixtures/graphics-game.ts (the active game's sim, the
 * fixture's scene) on WebGPU and WebGL 2. Probe pixels come from the page's own screenshot, located
 * with __game.project: two BLEND cards (the striped wall shows through the blue one; the nearer
 * blue card wins where they overlap, so they were sorted back to front), a MASK card (its
 * cut-out half shows the background), depth of field (the far striped wall loses contrast,
 * the in-focus subject is unchanged), a "bump" card (Style.bumpHeight shades relief into it; the
 * change from flat is the same on both backends) and the clouds in the sky above the far wall
 * (Style.cloudOpacity takes them away, cloudTint colours them, the same on both backends).
 */
async function materials(cdp, noAPI, receipts) {
  /** Per backend: the bump card's luminance change from flat, and the sky's from no clouds, pixel by pixel (compared across backends at the end). */
  const relief = {}, clouds = {};
  const g = viteGameConfig(active), buildDir = fileURLToPath(new URL('materials-build/', out));
  await build({ configFile: false, root, base: './', publicDir: g.publicDir, logLevel: 'warn',
    plugins: g.plugins, resolve: { alias: [
      { find: /^@game$/, replacement: join(root, 'tests/fixtures/graphics-game.ts') },
      { find: '@fixture-base-game', replacement: join(active.abs, 'src/index.ts') },
      ...g.resolve.alias,
    ] }, define: { ...g.define, 'import.meta.env.VITE_PLATFORM': JSON.stringify('web') },
    build: { target: 'es2022', outDir: buildDir, emptyOutDir: true, rollupOptions: { input: join(root, 'index.html') } },
  });
  const site = await preview({ configFile: false, root, logLevel: 'warn', build: { outDir: buildDir }, preview: { host: '127.0.0.1', port: 0 } });
  const url = site.resolvedUrls.local[0];
  try {
    for (const renderer of ['webgpu', 'webgl2']) {
      const name = `materials-${renderer}`;
      const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
      const p=await cdp.attach(targetId), errors=[];
      p.on(m=> {
        if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
        if(m.method==='Runtime.consoleAPICalled' && ['error','assert'].includes(m.params.type)) errors.push(m.params.args.map(a=>a.value ?? a.description).join(' '));
      });
      await p.S('Runtime.enable'); await p.S('Page.enable');
      await p.S('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
      if (renderer === 'webgl2') await p.S('Page.addScriptToEvaluateOnNewDocument',{source:noAPI});
      await p.S('Page.navigate',{url:`${url}?capture&autostart&nolock&seed=7&renderer=${renderer}`});
      await p.waitFor('!!window.__game && !!window.__probes',30000,name);
      assert.equal((await p.evalJS('__game.graphics()')).backend, renderer);
      await p.evalJS('__game.step(240)');
      assert.equal(await p.evalJS('__game.phase()'),'playing');
      const stats = await p.evalJS('__game.stats()');
      assert.equal(stats.translucentDraws, 3, `${name}: two glass cards and the pool draw in the translucent pass`);
      const shot = async (label) => {
        await p.S('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
        const {data}=await p.S('Page.captureScreenshot',{format:'png'});
        writeFileSync(new URL(`${name}${label}.png`,out),Buffer.from(data,'base64'));
        return data;
      };
      // Mean display RGB (0..1) and luminance spread over a (2r+1)² square around each probe.
      const probe = (data, r) => p.evalJS(`(async () => {
        const img = new Image(); img.src = 'data:image/png;base64,${data}'; await img.decode();
        const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const out = {};
        for (const [k, at] of Object.entries(__probes)) {
          const [px, py] = __game.project(...at).map(Math.round);
          const d = x.getImageData(px - ${r}, py - ${r}, ${2 * r + 1}, ${2 * r + 1}).data, n = d.length / 4, sum = [0, 0, 0], lum = [];
          for (let i = 0; i < d.length; i += 4) { for (let j = 0; j < 3; j++) sum[j] += d[i + j] / 255; lum.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255); }
          const mean = lum.reduce((a, b) => a + b, 0) / n;
          out[k] = { at: [px, py], rgb: sum.map(v => +(v / n).toFixed(4)), spread: +Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / n).toFixed(4), raw: Array.from(d) };
        }
        return out;
      })()`);
      const sharpShot = await shot('');
      const sharp = await probe(sharpShot, 10);
      const [, gr, b] = sharp.blendOverlap.rgb, solid = sharp.maskSolid.rgb, cut = sharp.maskCut.rgb;
      assert.ok(b > gr + 0.05, `${name}: the nearer blue card is over the green one (${sharp.blendOverlap.rgb})`);
      assert.ok(sharp.blueOverWall.spread > 0.04, `${name}: the striped wall shows through the blue card (spread ${sharp.blueOverWall.spread})`);
      const yellow = ([cr, cg, cb]) => Math.min(cr, cg) - cb;
      assert.ok(yellow(solid) > 0.3, `${name}: the MASK card's solid half draws (${solid})`);
      assert.ok(yellow(cut) < yellow(solid) - 0.25, `${name}: the MASK card's cut-out half shows the background (${cut} vs ${solid})`);
      // Bump: the card's grey pattern shades as relief at the default Style.bumpHeight, and flat at 0.
      const lum = (raw) => { const out = []; for (let i = 0; i < raw.length; i += 4) out.push((0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2]) / 255); return out; };
      const bumped = lum((await probe(sharpShot, 24)).relief.raw), height = await p.evalJS('__game.runtime.style.bumpHeight');
      await p.evalJS(`__game.runtime.style = { ...__game.runtime.style, bumpHeight: 0 }`);
      await p.evalJS('__game.step(1)');
      const flat = lum((await probe(await shot('-flat'), 24)).relief.raw);
      relief[renderer] = bumped.map((v, i) => v - flat[i]);
      const change = relief[renderer].reduce((a, v) => a + Math.abs(v), 0) / flat.length;
      assert.ok(change > 0.02, `${name}: the bump card shades as relief (mean luminance change ${change.toFixed(4)} from flat)`);
      await p.evalJS(`__game.runtime.style = { ...__game.runtime.style, bumpHeight: ${height} }`);
      // Clouds: the sky above the far wall (every 4th pixel, RGB 0..1) as drawn, with cloudOpacity 0 and with a red cloudTint.
      const sky = async (label) => { const data = label ? await shot(label) : sharpShot; return p.evalJS(`(async () => {
        const img = new Image(); img.src = 'data:image/png;base64,${data}'; await img.decode();
        const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const rows = Math.round(__game.project(0, 8, -40)[1]) - 6, d = x.getImageData(0, 0, img.width, rows).data, out = [];
        for (let y = 0; y < rows; y += 4) for (let i = 0; i < img.width; i += 4) { const k = (y * img.width + i) * 4; out.push([d[k] / 255, d[k + 1] / 255, d[k + 2] / 255]); }
        return out;
      })()`); };
      const look = (style) => p.evalJS(`__game.runtime.style = { ...__game.runtime.style, ...${JSON.stringify(style)} }; __game.step(1)`);
      const drawn = await sky('');
      await look({ cloudOpacity: 0 });
      const none = await sky('-noclouds');
      await look({ cloudOpacity: 1, cloudTint: [1, 0.25, 0.25] });
      const red = await sky('-redclouds');
      await look({ cloudTint: [1, 1, 1] });
      const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      clouds[renderer] = drawn.map((px, i) => luma(px) - luma(none[i]));
      const cloudy = clouds[renderer].map((v, i) => [v, i]).filter(([v]) => Math.abs(v) > 0.04).map(([, i]) => i);
      assert.ok(cloudy.length > drawn.length * 0.05, `${name}: clouds in the sky strip, gone at cloudOpacity 0 (${cloudy.length} of ${drawn.length} samples changed)`);
      const warmth = (set) => cloudy.reduce((a, i) => a + set[i][0] - set[i][2], 0) / cloudy.length;
      assert.ok(warmth(red) > warmth(drawn) + 0.1, `${name}: a red cloudTint reddens them (red minus blue ${warmth(drawn).toFixed(3)} → ${warmth(red).toFixed(3)})`);
      // Depth of field: the subject (about 6 m) stays in focus, the wall (about 46 m) blurs.
      await p.evalJS(`__game.runtime.style = { ...__game.runtime.style, dof: 1, dofNear: 2, dofFar: 15 }`);
      await p.evalJS('__game.step(1)');
      const soft = await probe(await shot('-dof'), 10);
      assert.ok(soft.wall.spread < sharp.wall.spread * 0.6, `${name}: the far wall blurs (${sharp.wall.spread} → ${soft.wall.spread})`);
      const drift = Math.max(...sharp.subject.raw.map((v, i) => Math.abs(v - soft.subject.raw[i])));
      assert.ok(drift <= 2, `${name}: the in-focus subject is unchanged (max channel difference ${drift})`);
      if (renderer === 'webgl2') assert.equal(await p.evalJS('__game.runtime.renderer.gl.getError()'), 0);
      assert.deepEqual(errors, [], name);
      const strip = (o) => Object.fromEntries(Object.entries(o).map(([k, { raw, ...v }]) => [k, v]));
      receipts.push({ name, backend: renderer, translucentDraws: stats.translucentDraws, sharp: strip(sharp), dof: strip(soft), reliefChange: +change.toFixed(4), cloudSamples: cloudy.length, skySamples: drawn.length });
      console.log(`[graphics] ok ${name}`);
      await cdp.send('Target.closeTarget',{targetId});
    }
    // The same relief on both backends: their changes from flat correlate pixel by pixel.
    const [a, b] = [relief.webgpu, relief.webgl2], mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    const [ma, mb] = [mean(a), mean(b)];
    const r = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
    assert.ok(r > 0.9, `bump relief matches across backends (correlation ${r.toFixed(3)})`);
    receipts.push({ name: 'bump-backends', correlation: +r.toFixed(4) });
    console.log(`[graphics] ok bump-backends (correlation ${r.toFixed(3)})`);
    const [ca, cb] = [clouds.webgpu, clouds.webgl2], [mca, mcb] = [mean(ca), mean(cb)];
    const rc = ca.reduce((s, x, i) => s + (x - mca) * (cb[i] - mcb), 0) / Math.sqrt(ca.reduce((s, x) => s + (x - mca) ** 2, 0) * cb.reduce((s, x) => s + (x - mcb) ** 2, 0));
    assert.ok(rc > 0.9, `clouds match across backends (correlation ${rc.toFixed(3)})`);
    receipts.push({ name: 'clouds-backends', correlation: +rc.toFixed(4) });
    console.log(`[graphics] ok clouds-backends (correlation ${rc.toFixed(3)})`);
    for (const renderer of ['webgpu', 'webgl2']) await textures(cdp, url, renderer, noAPI, receipts);
  } finally {
    await new Promise((resolve) => site.httpServer.close(resolve));
  }
}

/**
 * Textures: the fixture's `?fixture=textures` scene (TEXTURE_PROBES in tests/fixtures/graphics-game.ts). A NEAREST card
 * shows hard texel edges where the LINEAR card beside it, the same image, shows a gradient; far away, a NEAREST
 * minification filter aliases while NEAREST_MIPMAP_NEAREST reads the averaged mip. The live resource counts show
 * one upload per image on WebGPU (per image and sampler on WebGL 2), a second source of the same doc sharing them,
 * and every release giving back exactly what it should; the drawn source outlives the released one.
 */
async function textures(cdp, url, renderer, noAPI, receipts) {
  const name = `textures-${renderer}`;
  const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const p=await cdp.attach(targetId), errors=[];
  p.on(m=> {
    if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if(m.method==='Runtime.consoleAPICalled' && ['error','assert','warn'].includes(m.params.type)) errors.push(m.params.args.map(a=>a.value ?? a.description).join(' '));
  });
  await p.S('Runtime.enable'); await p.S('Page.enable');
  await p.S('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  if (renderer === 'webgl2') await p.S('Page.addScriptToEvaluateOnNewDocument',{source:noAPI});
  await p.S('Page.navigate',{url:`${url}?capture&autostart&nolock&seed=7&renderer=${renderer}&fixture=textures`});
  await p.waitFor('!!window.__game && !!window.__textures',30000,name);
  assert.equal((await p.evalJS('__game.graphics()')).backend, renderer);
  await p.evalJS('__game.step(240)');
  assert.equal(await p.evalJS('__game.phase()'),'playing');
  const r = await p.evalJS('__textures.report');
  // WebGPU: one texture per image (2), the sampler is per material. WebGL 2: one per image and sampler (4), plus a joint texture per model.
  const perSource = renderer === 'webgpu' ? 2 : 5, perModel = renderer === 'webgpu' ? 0 : 1;
  assert.equal(r.uploaded.textures - r.before.textures, perSource, `${name}: textures for one upload (${JSON.stringify(r)})`);
  assert.equal(r.second.textures, r.uploaded.textures + perModel, `${name}: a second upload of the same doc shares its images`);
  assert.equal(r.instanced.textures, r.second.textures + perModel, `${name}: an instance shares its source's textures`);
  assert.equal(r.retextured.textures, r.instanced.textures + 1, `${name}: retexture makes one private spare`);
  assert.deepEqual(r.restored, r.retextured, `${name}: rewriting and restoring reuse the spare`);
  assert.deepEqual(r.instanceReleased, r.second, `${name}: releasing the instance gives back its own resources only`);
  assert.deepEqual(r.firstReleased, r.uploaded, `${name}: releasing one source keeps the textures the other still uses`);
  await p.S('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
  const {data}=await p.S('Page.captureScreenshot',{format:'png'});
  writeFileSync(new URL(`${name}.png`,out),Buffer.from(data,'base64'));
  const probes = await p.evalJS(`(async () => {
    const img = new Image(); img.src = 'data:image/png;base64,${data}'; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const lum = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const at = (p) => __game.project(...p).map(Math.round);
    // Along a row: the darkest and lightest values and how many pixels lie well between them.
    const row = ([a, b]) => {
      const [x0, y] = at(a), [x1] = at(b), d = x.getImageData(x0, y, x1 - x0 + 1, 1).data, L = [];
      for (let i = 0; i < d.length; i += 4) L.push(lum(d, i));
      const lo = Math.min(...L), hi = Math.max(...L), band = (hi - lo) * 0.15;
      return { at: [x0, y, x1], n: L.length, lo: +lo.toFixed(4), hi: +hi.toFixed(4), between: L.filter((v) => v > lo + band && v < hi - band).length };
    };
    // Luminance spread over a 9 × 9 square.
    const square = ([p]) => {
      const [px, py] = at(p), d = x.getImageData(px - 4, py - 4, 9, 9).data, L = [];
      for (let i = 0; i < d.length; i += 4) L.push(lum(d, i));
      const mean = L.reduce((s, v) => s + v, 0) / L.length;
      return { at: [px, py], mean: +mean.toFixed(4), spread: +Math.sqrt(L.reduce((s, v) => s + (v - mean) ** 2, 0) / L.length).toFixed(4) };
    };
    return { nearest: row(__probes.nearest), linear: row(__probes.linear), noMip: square(__probes.noMip), mip: square(__probes.mip) };
  })()`);
  const { nearest, linear, noMip, mip } = probes;
  assert.ok(nearest.hi - nearest.lo > 0.15 && nearest.between <= 3, `${name}: NEAREST magnification shows hard texel edges (${JSON.stringify(nearest)})`);
  assert.ok(linear.hi - linear.lo > 0.1 && linear.between > linear.n * 0.4, `${name}: LINEAR on the same image blends texels (${JSON.stringify(linear)})`);
  assert.ok(noMip.spread > 0.1, `${name}: NEAREST minification without mipmaps aliases the far checker (${JSON.stringify(noMip)})`);
  assert.ok(mip.spread < 0.04 && mip.spread * 3 < noMip.spread, `${name}: NEAREST_MIPMAP_NEAREST reads the averaged mip (${JSON.stringify(mip)} vs ${JSON.stringify(noMip)})`);
  const after = await p.evalJS('__textures.release()');
  assert.deepEqual(after, r.before, `${name}: releasing the last source frees every texture and buffer`);
  await p.evalJS('__game.step(2)');
  if (renderer === 'webgl2') assert.equal(await p.evalJS('__game.runtime.renderer.gl.getError()'), 0);
  assert.deepEqual(errors, [], name);
  receipts.push({ name, backend: renderer, resources: r, released: after, probes });
  console.log(`[graphics] ok ${name} (nearest ${nearest.between}/${nearest.n} between, linear ${linear.between}/${linear.n}; far spread ${noMip.spread} without mipmaps, ${mip.spread} with)`);
  await cdp.send('Target.closeTarget',{targetId});
}
