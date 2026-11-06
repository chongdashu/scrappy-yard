// The scrapyard greybox gym's part of the browser smoke check (the engine's tests/smoke.mjs
// runs it: see "smoke" in game/game.json). The engine drives boot, menu, Play (the gym skips
// the countdown), pause, settings, resume and the way back to the menu; these drivers play the
// gym with real input. `?practice` makes nothing lethal so the round is still playing when the
// driver hands back.
//
// Each driver gets `t`: { name, p (CDP page: evalJS, waitFor, S), game(expr) (window.__game),
// key(code, down), tap(code), press(selector), shot(label), check(ok, what), log, sleep, touch,
// width, height, visible(selector) (an expression), waitPhase(phase, ms), clocks() }.

async function common(t) {
  const { p, game, check } = t;
  const hud = await p.evalJS(`(() => ({
    hud: !document.querySelector("#hud").hidden,
    // No on-screen control strip: it covered the oncoming track (controls live in Help).
    hints: document.querySelectorAll("#hint-keys, #hint-touch, .gym-hint").length,
    radar: document.querySelectorAll("#gym-warn").length,
    gymPanel: !!document.querySelector("#gym-panel") && getComputedStyle(document.querySelector("#gym-panel")).display !== "none",
    pauseHelp: !!document.querySelector("#pause-help"),
    nuts: document.querySelector("#hud-nuts")?.textContent,
    progress: !!document.querySelector("#hud-progress"),
  }))()`);
  check(hud.hud && hud.progress, `${t.name}: HUD shown while playing`);
  check(hud.hints === 0, `${t.name}: no bottom control-hint strip (${hud.hints})`);
  check(hud.radar === 0, `${t.name}: lane radar cards removed (${hud.radar})`);
  check(!hud.gymPanel, `${t.name}: gym Bounds/Practice/Camera panel hidden without ?gym`);
  check(!hud.pauseHelp, `${t.name}: pause How to play removed`);
  check(await game("scene()") === "gym", `${t.name}: opened the gym scene`);
  const pm = await game("playerModel()");
  check(pm.loaded && Math.abs(pm.height - 1.1) < 0.1, `${t.name}: player is the raccoon GLB at ~1.1 m (${JSON.stringify(pm)})`);
  // Statics stream in after the raccoon; wait for the background queue (placeholders until then).
  await p.waitFor(
    `(() => { const s = window.__game.staticModels(); window.__smDbg = JSON.stringify({l: s.loaded.length, m: s.missing, p: s.pending}); return s.pending.length === 0 && s.loaded.length === 19 && s.missing.length === 0; })()`,
    90000,
    "static GLBs finished streaming",
  ).catch(async (e) => { console.log("[smoke] statics:", await p.evalJS("window.__smDbg")); throw e; });
  const sm = await game("staticModels()");
  check(sm.missing.length === 0 && sm.loaded.length === 19, `${t.name}: all 19 static GLBs (incl. env dressing + side terrain) loaded (${JSON.stringify(sm)})`);
  const s = await game("stats()");
  check(s.state === 1 && s.practice === 1, `${t.name}: playing straight away, practice on (state ${s.state})`);
  return hud;
}

async function desktop(t) {
  const { game, key, tap, shot, check, sleep } = t;
  await common(t);
  const preset0 = (await game("camera()")).preset;
  check(preset0 === "heads-up", `desktop: default camera is the heads-up preset (${preset0})`);
  // The run-up nut line sits in the centre lane at z 12–18 (wait on the sim, not the wall clock:
  // software WebGL2 can run at 10 fps and the sim clamps long frames).
  await t.p.waitFor(`window.__game.player().z > 19`, 60000, "past the run-up nuts");
  let s = await game("stats()");
  check(s.nuts >= 3, `desktop: collected run-up nuts in the centre lane (${s.nuts})`);
  const xa = (await game("player()")).x;
  // Continuous strafe (no lane snap): hold A until the player has slid screen-left.
  await key("KeyA", true);
  await t.p.waitFor(`window.__game.player().x < ${xa - 0.3}`, 40000, "held A strafing left");
  await key("KeyA", false);
  let pl = await game("player()");
  check(pl.x < xa - 0.1, `desktop: A tap strafed screen-left / −X (x ${xa.toFixed(2)} → ${pl.x.toFixed(2)})`);
  // Free strafe: holding D slides right continuously; letting go stops where the player is.
  const x0 = pl.x;
  // (Wait on the sim, not the wall clock: software WebGL2 can run at a few fps.)
  await key("KeyD", true);
  await t.p.waitFor(`window.__game.player().x > ${x0 + 1.9}`, 40000, "held D strafing right");
  await key("KeyD", false);
  await sleep(150);
  const x1 = (await game("player()")).x;
  await sleep(250);
  pl = await game("player()");
  check(x1 > x0 + 0.8 && Math.abs(pl.x - x1) < 1e-3, `desktop: holding D strafed right and stopped on release (x ${x0.toFixed(2)} → ${x1.toFixed(2)} → ${pl.x.toFixed(2)})`);
  await shot("strafe");
  const xr = pl.x;
  // Arrow keys strafe too: ← back toward the centre, then → right again.
  await key("ArrowLeft", true);
  await t.p.waitFor(`window.__game.player().x < ${xr - 0.5}`, 40000, "held ← strafing left");
  await key("ArrowLeft", false);
  const xl = (await game("player()")).x;
  await key("ArrowRight", true);
  await t.p.waitFor(`window.__game.player().x > ${xl + 0.5}`, 40000, "held → strafing right");
  await key("ArrowRight", false);
  pl = await game("player()");
  check(xl < xr - 0.3 && pl.x > xl + 0.3, `desktop: ← / → strafed left then right (x ${xr.toFixed(2)} → ${xl.toFixed(2)} → ${pl.x.toFixed(2)})`);
  await key("Space", true);
  await sleep(120);
  await key("Space", false);
  pl = await game("player()");
  check(pl.y > 0.3, `desktop: Space jumped (y ${pl.y.toFixed(2)})`);
  await tap("KeyX");
  // Toggles apply on the next rendered frame; software frames can be slow.
  for (let i = 0; i < 15 && (await game("showBounds()")) !== true; i++) await sleep(100);
  check(await game("showBounds()") === true, "desktop: X shows collision bounds");
  await sleep(200);
  await shot("play");
  await tap("KeyV");
  for (let i = 0; i < 15 && (await game("camera()")).preset === preset0; i++) await sleep(100);
  const cam = await game("camera()");
  check(cam.preset !== preset0, `desktop: V cycled the camera preset (${cam.preset})`);
  await tap("KeyV");
  await tap("KeyV");
  await tap("KeyX");
  s = await game("stats()");
  check(s.state === 1, "desktop: still playing in practice");
  // Move a little so the engine's pause check sees a running player.
  await key("KeyD", true);
  await sleep(300);
  await key("KeyD", false);
}

async function phone(t) {
  const { p, game, shot, check, sleep, width, height, press } = t;
  await common(t);
  await sleep(600);
  const px0 = (await game("player()")).x;
  const ox = width * 0.3, oy = height * 0.75;
  await p.S("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: ox, y: oy, id: 7 }] });
  await sleep(80);
  await p.S("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: ox - 60, y: oy, id: 7 }] });
  await sleep(250);
  await p.S("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: ox, y: oy, id: 7 }] });
  await sleep(100);
  let pl = await game("player()");
  check(pl.x < px0 - 0.1, `phone: a stick flick left strafed left (x ${px0.toFixed(2)} → ${pl.x.toFixed(2)})`);
  await shot("play");
  await p.S("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await press(".touch-btn-large");
  await sleep(60);
  pl = await game("player()");
  check(pl.y > 0.05 || pl.grounded === 0, `phone: JUMP button jumped (y ${pl.y.toFixed(2)})`);
  await sleep(800);
  const s = await game("stats()");
  check(s.state === 1, "phone: still playing in practice");
}

export default {
  desktop: { query: "?seed=7&practice", drive: desktop },
  phone: { query: "?seed=3&practice", drive: phone },
};
