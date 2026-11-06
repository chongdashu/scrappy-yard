// Deterministic gameplay capture: ?capture stepping, 2 sim frames (1/30 s) per screenshot.
// node capture.mjs <name> <frames> [query extra] [--intro] [--renderer=webgl2] [--warm=N]
import { connect, launchChrome } from "/home/box/vgd-wasm-game-template/games/blank-start/tests/lib/cdp.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
const [name, framesArg, extra = ""] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const intro = process.argv.includes("--intro");
const renderer = flag("renderer", "webgl2");
const warm = Number(flag("warm", 0));       // sim frames (60 Hz) to run before recording
const hideHud = process.argv.includes("--nohud");
const frames = Number(framesArg); const tiny = process.argv.includes('--tiny');
const W = Number(flag("w", 1280)), H = Number(flag("h", 720));
const out = `frames/${name}`; rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const ch = await launchChrome({ width: W, height: H });
process.on("exit", () => { try { ch.proc.kill("SIGKILL"); } catch {} });
process.on("SIGTERM", () => process.exit(143));
const c = await connect(ch.wsUrl);
const [pg] = await c.pages();
const p = await c.attach(pg.targetId);
await p.S("Page.enable"); await p.S("Runtime.enable");
p.on("Runtime.exceptionThrown", (e) => console.log("EXC", e.exceptionDetails.exception?.description?.slice(0, 300)));
await p.S("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await p.S("Page.addScriptToEvaluateOnNewDocument", { source: `
 let __g; Object.defineProperty(window,'__game',{configurable:true,get(){return __g},set(v){__g=v;
   const g=v.runtime.game; g.govern=()=>{}; g.cam=${Number(flag("cam",0))};
   ${intro ? "g.skipCountdown=()=>false;" : ""}
   const r=v.runtime.renderer; const f=r.finished.bind(r); r.finished=()=>f().catch(()=>null);
 }});` });
// Hold the round until statics load: navigate WITHOUT autostart side effects by stepping 0 until ready.
const URL0 = `http://127.0.0.1:5190/?capture&autostart&nolock${process.argv.includes("--nopractice")?"":"&practice"}&renderer=${renderer}${extra}`;
p.on("Runtime.consoleAPICalled", (e) => { if (e.type === "warning" && String(e.args[0]?.value).includes("did not load")) console.log("WARN", e.args.map(a => a.value ?? a.description).join(" ").slice(0, 300)); });
for (let attempt = 0; ; attempt++) {
  await p.S("Page.navigate", { url: URL0 });
  await new Promise(r => setTimeout(r, 1500));
  await p.waitFor("window.__game && window.__game.step && window.__game.staticModels", 90000);
  await p.waitFor("window.__game.staticModels().pending.length===0", 180000).catch((e) => console.log("statics", e.message));
  const miss = await p.evalJS("window.__game.staticModels().missing.length");
  console.log("statics attempt", attempt, await p.evalJS("JSON.stringify({l:window.__game.staticModels().loaded.length, m:window.__game.staticModels().missing})"));
  if (miss === 0 || attempt >= 4) break;
}
console.log(name, await p.evalJS("JSON.stringify(window.__game.graphics())"));
await p.evalJS(`window.__game.pixelBudget({maxPixels:${tiny ? 64*36 : W * H}, maxDpr:1})`);
console.log("statics", await p.evalJS("JSON.stringify({l:window.__game.staticModels().loaded.length, m:window.__game.staticModels().missing})"));
if (hideHud) await p.evalJS(`(() => {
  const hide = (sel) => { const el = document.querySelector(sel); if (el) el.style.display = 'none'; };
  hide('#hud'); hide('#pops'); hide('#dbg'); hide('#dbg-toggle'); hide('#tuning'); hide('#tune-toggle');
  document.querySelectorAll('[data-dev-only], button').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (/^Debug|^Tune|^Mobile/i.test(t)) el.style.display = 'none';
  });
})()`);
// Autopilot: dodge cars into a free lane, jump barrels and gaps in the player's lane, otherwise drift toward nuts / a weave target.
await p.evalJS(`(() => {
  const LW = 1.4; let t = 0; window.__nojump = ${process.argv.includes("--nojump")}; window.__crash = ${process.argv.includes("--crash")}; window.__weave = ${flag("weave", "null")};
  window.__game.autopilot = (dt) => {
    t += dt;
    const pl = window.__game.player(); const obs = window.__game.obstacles();
    const ahead = (lane, kind, lo, hi) => obs.filter(o => !o.hit && o.kind === kind && (kind === 3 || o.lane === lane) && (o.z - o.halfL - pl.z) > lo && (o.z - o.halfL - pl.z) < hi);
    let lane = Math.round(pl.x / LW); lane = Math.max(-1, Math.min(1, lane));
    let target = window.__tgt ?? lane;
    if (window.__weave) { const w = window.__weave; target = w[Math.floor(t / 1.2) % w.length]; }
    if (window.__crash) { const cars = obs.filter(o => o.kind === 2 && !o.hit && o.z - pl.z > 1).sort((a, b) => a.z - b.z); if (cars.length) target = cars[0].lane; }
    const carIn = (l) => !window.__crash && ahead(l, 2, -1.8, 13).length > 0;
    if (carIn(target)) { const opts = [lane, lane - 1, lane + 1, -1, 0, 1].filter(l => l >= -1 && l <= 1 && !carIn(l)); if (opts.length) target = opts[0]; }
    window.__tgt = target;
    const dx = target * LW - pl.x;
    const moveX = Math.abs(dx) < 0.08 ? 0 : Math.max(-1, Math.min(1, dx * 3));
    let moveY = 0;
    const nearLanes = [lane, Math.round((pl.x + Math.sign(dx) * 0.3) / LW)];
    const bar = obs.filter(o => !o.hit && o.kind === 1 && nearLanes.includes(o.lane)).map(o => o.z - pl.z).filter(d => d > 0 && d < 2.9);
    const gap = obs.filter(o => o.kind === 3).map(o => o.z - o.halfL - pl.z).filter(d => d > -0.2 && d < 0.9);
    if (((window.__nojump ? false : bar.length) || gap.length) && pl.grounded > 0.5) moveY = -1;
    return { moveX, moveY };
  };
})()`);
const shot = async (i) => { const r = await p.S("Page.captureScreenshot", { format: "jpeg", quality: 92, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } }); writeFileSync(`${out}/f${String(i).padStart(5, "0")}.jpg`, Buffer.from(r.data, "base64")); };
if (warm) await p.evalJS(`window.__game.pixelBudget({maxPixels:64*36, maxDpr:1})`);
for (let n = 0; n < warm; n += 30) await p.evalJS(`window.__game.step(${Math.min(30, warm - n)})`);
if (warm && !tiny) await p.evalJS(`window.__game.pixelBudget({maxPixels:${W * H}, maxDpr:1})`);
const t0 = Date.now();
const log = []; const per = [];
for (let i = 0; i < frames; i++) {
  await p.evalJS("window.__game.step(2)");
  if (!tiny) await shot(i);
  per.push(await p.evalJS("(() => { const g = window.__game, s = g.stats(), q = g.player(); return [s.nuts, s.stumbles, +q.y.toFixed(2), q.grounded, s.state, +q.rgap.toFixed(2), +q.x.toFixed(2), +q.z.toFixed(1)]; })()"));
  if (i % 30 === 0) { const s = await p.evalJS("JSON.stringify({ph:window.__game.phase(), z:window.__game.player().z.toFixed(1), x:window.__game.player().x.toFixed(2), st:window.__game.stats()})"); log.push(s); console.log(i, s, ((Date.now() - t0) / (i + 1)).toFixed(0) + "ms/f"); }
}
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1)); writeFileSync(`${out}/per.json`, JSON.stringify(per));
await ch.close(); process.exit(0);
