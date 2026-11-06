// Model preview (preview.html, a dev tool): load the project's GLBs, orbit
// around them, play and layer clips, and inspect skeletons, sockets, bounds
// and scale, rendered with the game's own renderer and look. Use it to accept
// an export before it goes into the game.
//
// The list is the active game's game.json "preview.models" (URLs relative to its public/).
// URL: ?model=<index>&clip=<name>&game=1&layered=1&yaw=<deg>&skeleton=1&paused&t=<s>
// make captures repeatable; ?url=<glb> previews any export without editing the list.
import "./preview.css";
import { DEFAULT_STYLE, Renderer, type Style } from "../gpu/renderer";
import { InstanceBatch, MESH, hex } from "../gpu/meshes";
import { ModelRenderer, modelBounds, type GpuModel } from "../gpu/model";
import { docStats, findNode, loadGlb, type GltfDoc } from "../gltf/glb";
import { Animator, type Layer, type Mask } from "../gltf/animator";
import { OrbitCamera } from "./orbit";
import { Overlay } from "./overlay";
import { mat4 } from "../math";
import { GAME } from "../config";
import type { PreviewModel } from "../game";

// A game's public/ is not globbable by Vite; its game.json lists what to preview.
const MODELS: PreviewModel[] = [...GAME.preview.models];
/** Ground distance per walk cycle when a GLB doesn't state `walk_stride_m` in its extras (m, assumed). */
const DEFAULT_WALK_STRIDE_M = 0.8;
/** A character's walk stride: `walk_stride_m` from any node's glTF extras, else the assumed default. */
const walkStride = (doc: GltfDoc): { m: number; stated: boolean } => {
  for (const n of doc.nodes) if (typeof n.extras.walk_stride_m === "number" && n.extras.walk_stride_m > 0) return { m: n.extras.walk_stride_m, stated: true };
  return { m: DEFAULT_WALK_STRIDE_M, stated: false };
};

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
let canvas = $<HTMLCanvasElement>("#view");
const infoEl = $("#info");
const errorEl = $("#error");
const panel = $("#panel");

function showError(msg: string) {
  errorEl.hidden = false;
  errorEl.textContent = msg;
  console.error("[preview]", msg);
}

interface Loaded {
  doc: GltfDoc;
  gpu: GpuModel;
  animator: Animator | null;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  stats: ReturnType<typeof docStats>;
}

const state = {
  model: 0,
  playing: true,
  time: 0,
  speed: 1,
  loop: true,
  layered: false,
  clip: "",
  lower: "",
  upper: "",
  upperWeight: 1,
  bodyYawDeg: 0,
  travel: false,
  travelDist: 0,
  skeleton: false,
  hideMesh: false,
  sockets: true,
  pole: true,
  grid: true,
  bounds: false,
  colliders: false,
  outline: true,
  game: false,
};

async function boot() {
  let renderer: Renderer;
  try {
    renderer = await Renderer.create(canvas);
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return;
  }
  canvas = renderer.canvas;
  renderer.onLost = (why) => showError(`GPU device lost: ${why}`);
  renderer.ground.visible = false; // the studio ground below replaces it
  renderer.skyVisible = false;
  const models = new ModelRenderer(renderer);
  const overlay = new Overlay(renderer);
  const camera = new OrbitCamera();
  camera.attach(canvas, () => (state.game = false));
  const batches = [new InstanceBatch(256), new InstanceBatch(256), new InstanceBatch(8), new InstanceBatch(256), new InstanceBatch(8)];
  const empty = new Float32Array(0);
  const style: Style = { ...DEFAULT_STYLE };

  let current: Loaded | null = null;
  let loading = 0;
  const cache = new Map<string, Loaded>();

  async function load(index: number) {
    const ticket = ++loading;
    state.model = index;
    errorEl.hidden = true;
    const { url } = MODELS[index];
    try {
      let l = cache.get(url);
      if (!l) {
        const doc = await loadGlb(new URL(url, document.baseURI).href);
        const gpu = models.upload(doc);
        const animator = doc.skins.length || doc.clips.length ? new Animator(doc) : null;
        l = { doc, gpu, animator, bounds: modelBounds(gpu), stats: docStats(doc) };
        cache.set(url, l);
      }
      if (ticket !== loading) return;
      current = l;
      state.time = 0;
      state.travelDist = 0;
      const clips = l.doc.clips.map((c) => c.name);
      state.clip = clips.includes("idle") ? "idle" : clips[0] ?? "";
      state.lower = clips.includes("walk") ? "walk" : state.clip;
      state.upper = clips.includes("cheer") ? "cheer" : state.clip;
      buildPanel();
      frameModel();
    } catch (e) {
      if (ticket === loading) showError(`Could not load ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function frameModel() {
    if (!current) return;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const { min, max } = current.bounds;
    if (state.game) camera.gamePreset(gameFocus(current), aspect);
    else {
      camera.yaw = 0.55;
      camera.pitch = current.animator ? 0.18 : 0.62;
      camera.fovY = (36 * Math.PI) / 180;
      camera.fit(min, max, aspect);
    }
  }

  /** Game framing centres on a spawn marker when the asset has one. */
  function gameFocus(l: Loaded): [number, number, number] {
    const i = l.doc.nodes.findIndex((n) => n.name.startsWith("mk_spawn"));
    if (i >= 0) {
      const w = l.gpu.world;
      return [w[i * 16 + 12], 0, w[i * 16 + 14]];
    }
    const { min, max } = l.bounds;
    return [(min[0] + max[0]) / 2, 0, (min[2] + max[2]) / 2];
  }

  // ---------------------------------------------------------------- panel
  function buildPanel() {
    panel.innerHTML = "";
    const h = (t: string) => panel.appendChild(Object.assign(document.createElement("h4"), { textContent: t }));
    const row = (label: string, el: HTMLElement, out?: HTMLElement, wide = false) => {
      const r = document.createElement("div");
      r.className = wide ? "row wide" : "row";
      r.append(Object.assign(document.createElement("span"), { textContent: label }), el);
      if (out) r.append(out);
      panel.appendChild(r);
    };
    const select = (options: string[], value: string, on: (v: string) => void, labels?: string[]) => {
      const s = document.createElement("select");
      options.forEach((o, i) => s.append(new Option(labels?.[i] ?? o, o, false, o === value)));
      s.addEventListener("change", () => on(s.value));
      return s;
    };
    const slider = (min: number, max: number, step: number, value: number, on: (v: number) => void, fmt = (v: number) => v.toFixed(2)) => {
      const i = Object.assign(document.createElement("input"), { type: "range", min: `${min}`, max: `${max}`, step: `${step}`, value: `${value}` });
      const o = document.createElement("output");
      o.textContent = fmt(value);
      i.addEventListener("input", () => {
        on(+i.value);
        o.textContent = fmt(+i.value);
      });
      return [i, o] as const;
    };
    const checks = (items: [keyof typeof state, string][]) => {
      const d = document.createElement("div");
      d.className = "checks";
      for (const [k, label] of items) {
        const l = document.createElement("label");
        const c = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!state[k] });
        c.addEventListener("change", () => {
          (state as Record<string, unknown>)[k] = c.checked;
          if (k === "game") frameModel();
        });
        l.append(c, label);
        d.append(l);
      }
      panel.appendChild(d);
    };
    const buttons = (items: [string, () => void, boolean?][]) => {
      const d = document.createElement("div");
      d.className = "buttons";
      for (const [t, fn, on] of items) {
        const b = Object.assign(document.createElement("button"), { textContent: t });
        if (on) b.classList.add("on");
        b.addEventListener("click", fn);
        d.append(b);
      }
      panel.appendChild(d);
    };

    h("Model");
    row("Asset", select(MODELS.map((_, i) => `${i}`), `${state.model}`, (v) => { state.model = +v; load(state.model); }, MODELS.map((m) => m.label)), undefined, true);
    buttons([
      ["Fit", () => { state.game = false; frameModel(); }],
      ["Game camera", () => { state.game = true; frameModel(); }, state.game],
    ]);

    const clips = current?.doc.clips.map((c) => c.name) ?? [];
    if (clips.length) {
      h("Animation");
      buttons([
        [state.playing ? "Pause" : "Play", () => { state.playing = !state.playing; buildPanel(); }],
        ["Single clip", () => { state.layered = false; buildPanel(); }, !state.layered],
        ["Layered", () => { state.layered = true; buildPanel(); }, state.layered],
      ]);
      if (!state.layered) {
        row("Clip", select(clips, state.clip, (v) => { state.clip = v; state.time = 0; }), undefined, true);
      } else {
        row("Base (all)", select(clips, state.lower, (v) => (state.lower = v)), undefined, true);
        row("Upper body", select(clips, state.upper, (v) => (state.upper = v)), undefined, true);
        const [w, wo] = slider(0, 1, 0.01, state.upperWeight, (v) => (state.upperWeight = v));
        row("Upper weight", w, wo);
      }
      const dur = current!.animator!.clipDuration(state.layered ? state.upper : state.clip) || 1;
      const [t, to] = slider(0, dur, 0.001, state.time % dur, (v) => { state.time = v; state.playing = false; }, (v) => `${v.toFixed(2)}s`);
      t.id = "scrub";
      to.id = "scrub-out";
      row("Time", t, to);
      const [s, so] = slider(0, 2, 0.05, state.speed, (v) => (state.speed = v), (v) => `${v.toFixed(2)}×`);
      row("Speed", s, so);
      const stride = walkStride(current!.doc);
      checks([["loop", "Loop"], ["travel", `Travel at stride speed (${stride.m} m/cycle${stride.stated ? "" : ", assumed"}; foot-slide check)`]]);
      if (current?.doc.skins.length) {
        h("Facing");
        const [by, byo] = slider(-180, 180, 1, state.bodyYawDeg, (v) => (state.bodyYawDeg = v), (v) => `${v.toFixed(0)}°`);
        row("Body yaw", by, byo);
        buttons([["Reset facing", () => { state.bodyYawDeg = 0; buildPanel(); }]]);
      }
    }

    h("Overlays");
    checks([["skeleton", "Skeleton"], ["hideMesh", "Hide mesh (x-ray)"], ["sockets", "Sockets"], ["pole", "1 m pole"], ["grid", "Grid"], ["bounds", "Bounds"], ["colliders", "Collider nodes (col_*)"], ["outline", "Ink outline"]]);
    h("Look");
    const [tn, tno] = slider(0, 1, 0.05, style.toon, (v) => (style.toon = v));
    row("Toon ramp", tn, tno);
    const [rimS, rimO] = slider(0, 3, 0.05, style.rim, (v) => (style.rim = v));
    row("Rim light", rimS, rimO);
    const [ex, exo] = slider(0.5, 2, 0.01, style.exposure, (v) => (style.exposure = v));
    row("Exposure", ex, exo);
  }

  $("#panel-toggle").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    $("#panel-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  });
  if (innerWidth < 640) panel.hidden = true;

  // ---------------------------------------------------------------- frame
  renderer.sceneHooks.push(() => {
    overlay.drawGround();
    models.draw();
    overlay.drawBackground();
    overlay.drawLines();
  });

  const root = mat4.identity();
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fpsShown = 0;
  let infoTimer = 0;

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 0.5) {
      fpsShown = Math.round(fpsN / fpsAcc);
      $("#fps").textContent = `${fpsShown} fps`;
      fpsAcc = 0;
      fpsN = 0;
    }
    for (const b of batches) b.reset();
    overlay.clearLines();
    models.outline = state.outline ? 1 : 0;
    style.inkPx = state.outline ? DEFAULT_STYLE.inkPx : 0;

    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    let shadowX = 0, shadowZ = 0, shadowR = 0.5;
    if (current) {
      const l = current;
      if (state.playing) state.time += dt * state.speed;
      const yaw = (state.bodyYawDeg * Math.PI) / 180;
      const walkDur = l.animator?.clipDuration("walk") || 1;
      if (state.travel && state.playing) state.travelDist += dt * state.speed * (walkStride(l.doc).m / walkDur);
      if (!state.travel) state.travelDist = 0;
      const tx = Math.sin(yaw) * state.travelDist, tz = Math.cos(yaw) * state.travelDist;
      mat4.compose(root, 0, tx, 0, tz, yaw, 0, 0, 1, 1, 1);
      if (l.animator) {
        const layers: Layer[] = state.layered
          ? [
              { clip: state.lower, time: state.time, mask: "all" as Mask, loop: state.loop },
              { clip: state.upper, time: state.time, mask: "upper" as Mask, weight: state.upperWeight, loop: state.loop },
            ]
          : [{ clip: state.clip, time: state.time, loop: state.loop }];
        l.animator.update(layers, root);
        if (!state.hideMesh) models.prepareSkinned(l.gpu, l.animator);
        overlays(l);
      } else if (!state.hideMesh) {
        models.prepareStatic(l.gpu, { root });
      }
      if (state.colliders) {
        // Collider/marker nodes are hidden from rendering; outline their node boxes.
        l.doc.nodes.forEach((n, i) => {
          if (!n.name.startsWith("col_") && !n.name.startsWith("mk_")) return;
          const m = l.gpu.world.subarray(i * 16, i * 16 + 16);
          if (n.name.startsWith("mk_")) overlay.axes(m, 0.35);
          else if (n.mesh >= 0) {
            const b = nodeBox(l.doc, i, m);
            if (b) overlay.box(b.min, b.max, [1, 0.3, 0.3]);
          }
        });
      }
      const { min, max } = l.bounds;
      shadowX = (min[0] + max[0]) / 2 + tx;
      shadowZ = (min[2] + max[2]) / 2 + tz;
      shadowR = Math.max(0.3, Math.max(max[0] - min[0], max[2] - min[2]) * 0.55);
      if (state.pole) {
        const px = max[0] + 0.35 + tx, pz = tz;
        batches[MESH.cylinder].push(px, 0, pz, 0, 0, 0, 0.035, 1.0, 0.035, hex(0xffd21f), 0.5);
        batches[MESH.sphere].push(px, 1.0, pz, 0, 0, 0, 0.08, 0.08, 0.08, hex(0xff5a36), 0.8);
      }
      if (state.bounds) overlay.box([min[0] + tx, min[1], min[2] + tz], [max[0] + tx, max[1], max[2] + tz], [1, 0.8, 0.2]);
      const scrub = document.querySelector("#scrub") as HTMLInputElement | null;
      if (scrub && state.playing && l.animator) {
        const dur = l.animator.clipDuration(state.layered ? state.upper : state.clip) || 1;
        const t = state.loop ? state.time % dur : Math.min(state.time, dur);
        scrub.value = `${t}`;
        const o = document.querySelector("#scrub-out");
        if (o) o.textContent = `${t.toFixed(2)}s`;
      }
      if (state.game) camera.gamePreset(l.animator ? [shadowX, 0, shadowZ] : gameFocus(l), aspect);
      else if (state.travel) camera.target = [shadowX, camera.target[1], shadowZ];
    }
    overlay.groundData.set([shadowX, shadowZ, shadowR, current?.animator ? 0.5 : 0.3], 0);
    const groundSize = current ? Math.max(8, Math.hypot(current.bounds.max[0] - current.bounds.min[0], current.bounds.max[2] - current.bounds.min[2]) * 1.2) : 8;
    overlay.prepare(state.grid, groundSize, 0, current ? Math.min(0, current.bounds.min[1]) : 0);
    // Centre the subject in the area left of the side panel (desktop layout).
    const panelW = !panel.hidden && canvas.clientWidth > 640 ? panel.getBoundingClientRect().width + 20 : 0;
    camera.shiftX = panelW / Math.max(1, canvas.clientWidth);
    camera.update(aspect);

    renderer.render(canvas, { camera, time: now / 1000, dt, style, batches, particles: empty, particleCount: 0, blobs: empty, blobCount: 0 });

    infoTimer -= dt;
    if (current && infoTimer <= 0) {
      infoTimer = 0.25;
      const s = current.stats;
      const b = current.bounds;
      const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => v.toFixed(2)).join(" × ");
      const lines = [
        MODELS[state.model].url,
        `${s.instancedTriangles.toLocaleString()} tris · ${s.instancedPrimitives} primitives · ${s.materials} materials${s.textures ? ` (${s.textures} textured)` : ""}`,
        `${models.stats.draws} draws/frame (${state.outline ? "fill + ink" : "fill only"}) · ${s.nodes} nodes`,
        `bounds ${size} m (drawn nodes)`,
      ];
      if (s.joints) lines.push(`${s.joints} joints`);
      if (s.clips.length) lines.push(`clips: ${s.clips.map((c) => `${c.name} ${c.duration.toFixed(3)}s`).join(" · ")}`);
      const mats = current.doc.materials.map((m) => m.name).join(", ");
      if (mats) lines.push(`materials: ${mats}`);
      infoEl.textContent = lines.join("\n");
    }
  };

  /** World AABB of one node's mesh (for collider outlines). */
  function nodeBox(doc: GltfDoc, node: number, m: Float32Array) {
    const mesh = doc.meshes[doc.nodes[node].mesh];
    if (!mesh) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.primitives) {
      for (let i = 0; i < p.positions.length; i += 3) {
        const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2];
        const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], w[k]);
          max[k] = Math.max(max[k], w[k]);
        }
      }
    }
    return { min, max };
  }

  /** A thin cylinder between two joints (depth tested, so it reads as a solid bone). */
  function bone(a: [number, number, number], b: [number, number, number], color: number) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const pitch = Math.acos(Math.max(-1, Math.min(1, dy / len)));
    const yaw = Math.atan2(dx, dz);
    batches[MESH.cylinder].push(a[0], a[1], a[2], yaw, pitch, 0, 0.018, len, 0.018, hex(color), 0.5, 0, 0.4);
  }

  function overlays(l: Loaded) {
    const a = l.animator!;
    const doc = l.doc;
    if (state.skeleton && doc.skins.length) {
      const joints = doc.skins[0].joints;
      const set = new Set(joints);
      for (const j of joints) {
        const p = doc.nodes[j].parent;
        if (p < 0 || !set.has(p)) continue;
        const w = a.world, c = j * 16, pc = p * 16;
        const socket = doc.nodes[j].name.startsWith("socket_");
        const pa: [number, number, number] = [w[pc + 12], w[pc + 13], w[pc + 14]];
        const pb: [number, number, number] = [w[c + 12], w[c + 13], w[c + 14]];
        overlay.line(pa, pb, socket ? [0.2, 0.9, 1] : a.isUpper(j) ? [1, 0.55, 0.15] : [0.95, 0.9, 0.2]);
        if (!socket) bone(pa, pb, a.isUpper(j) ? 0xff8a1f : 0xf2e21a);
      }
      for (const j of joints) {
        if (doc.nodes[j].name.startsWith("socket_")) continue;
        const c = j * 16;
        batches[MESH.sphere].push(a.world[c + 12], a.world[c + 13], a.world[c + 14], 0, 0, 0, 0.035, 0.035, 0.035, hex(0xffffff), 0.6, 0, 0.5);
      }
    }
    if (state.sockets) {
      // Any node named socket_* (attachment points by convention), shown as axes.
      doc.nodes.forEach((n, i) => {
        if (n.name.startsWith("socket_")) overlay.axes(a.world.subarray(i * 16, i * 16 + 16), 0.12);
      });
    }
  }

  const q = new URLSearchParams(location.search);
  const custom = q.get("url");
  if (custom) MODELS.unshift({ label: `custom: ${custom}`, url: custom });
  if (!MODELS.length) {
    // Nothing to show yet: say how to add something instead of failing.
    infoEl.textContent = `${GAME.title} lists no models to preview yet.\nAdd { "label", "url" } entries to "preview.models" in its game.json\n(URLs relative to its public/ folder), or open preview.html?url=assets/<file>.glb.`;
    buildPanel();
    requestAnimationFrame(frame);
    return;
  }
  state.model = Math.max(0, Math.min(MODELS.length - 1, +(q.get("model") ?? 0) || 0));
  state.game = q.get("game") === "1";
  state.layered = q.get("layered") === "1";
  state.skeleton = q.get("skeleton") === "1";
  state.bodyYawDeg = +(q.get("yaw") ?? 0) || 0;
  if (q.has("paused")) state.playing = false;
  await load(state.model);
  if (q.get("clip") && current) state.clip = q.get("clip")!;
  if (q.has("t")) state.time = +(q.get("t") ?? 0);
  buildPanel();
  (window as unknown as { __preview: unknown }).__preview = {
    state,
    load,
    graphics: () => renderer.info(),
    stats: () => ({ draws: models.stats.draws, triangles: models.stats.triangles, fps: fpsShown, loaded: current?.doc.url ?? null }),
    frame: () => frameModel(),
    camera,
    findNode: (name: string) => (current ? findNode(current.doc, name) : -1),
  };
  requestAnimationFrame(frame);
}

void boot();
