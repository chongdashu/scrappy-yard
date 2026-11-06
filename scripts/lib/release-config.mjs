// Shared by the packager, the release server and the deploy scripts: the active game's
// identity (<gameDir>/game.json, via active-game.mjs), the release rules (deploy/release.json)
// and deploy receipts.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ROOT, SAFE_NAME, loadActiveGame } from "./active-game.mjs";

export { ROOT, SAFE_NAME, loadActiveGame };

const readJson = async (path, what) => {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`${what} not found: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${e.message}`);
  }
};

/** The active game's game.json: `id` names builds and the release server's prefix; `title` goes in receipts. */
export async function loadGameConfig(root = ROOT) {
  return loadActiveGame(root).manifest;
}

/**
 * deploy/release.json (engine-wide release rules), with defaults filled and every target
 * validated. The public web root and the asset allowlist come from the active game.
 */
export async function loadReleaseConfig(root = ROOT) {
  const raw = await readJson(join(root, "deploy/release.json"), "deploy/release.json");
  for (const moved of ["assets", "publicDir"]) {
    if (moved in raw) throw new Error(`deploy/release.json "${moved}" belongs to the game now: set "release.assets" in <gameDir>/game.json (the web root is <gameDir>/public).`);
  }
  const cfg = {
    entry: "index.html",
    maxFileBytes: 25 * 1024 * 1024,
    devMarker: "vgd:dev-only",
    runtimeExtensions: [],
    sourcePaths: ["src", "index.html"],
    preflight: [],
    prebuild: [],
    forbidden: [],
    requireSmoke: true,
    targets: {},
    ...raw,
  };
  if (typeof cfg.requireSmoke !== "boolean") throw new Error(`deploy/release.json "requireSmoke" must be true or false (got ${JSON.stringify(cfg.requireSmoke)}).`);
  for (const step of [...cfg.preflight, ...cfg.prebuild]) {
    if (!step?.name || !Array.isArray(step.run) || !step.run.length) throw new Error(`deploy/release.json: each preflight/prebuild step needs "name" and a non-empty "run" array: ${JSON.stringify(step)}`);
  }
  for (const [name, t] of Object.entries(cfg.targets)) {
    if (!SAFE_NAME.test(name)) throw new Error(`deploy/release.json target name must match ${SAFE_NAME}: ${name}`);
    if (!t?.env?.VITE_PLATFORM) throw new Error(`deploy/release.json target "${name}" needs env.VITE_PLATFORM (web, wavedash or crazygames).`);
  }
  return cfg;
}

export function targetConfig(cfg, name) {
  const t = cfg.targets[name];
  if (!t) throw new Error(`Unknown release target "${name}". deploy/release.json defines: ${Object.keys(cfg.targets).join(", ") || "none"}.`);
  return t;
}

/** Deploy scripts talk to real hosts: refuse to run inside a test harness. */
export function assertNotUnderTest(what) {
  if (process.env.NODE_TEST_CONTEXT || process.env.VITEST) throw new Error(`${what} deploys to a real host and never runs under a test harness.`);
}

/** Release paths for a target: the upload directory, its review manifest and its smoke record (neither uploaded). */
export const releasePaths = (root, target) => ({
  dir: join(root, "release", target),
  manifest: join(root, "release", `${target}-manifest.json`),
  /** Written by a full, passing `npm run smoke` (the web target only); uploads check it (package-game.mjs assertSmoked). */
  smoke: join(root, "release", `${target}-smoke.json`),
});

export const receiptPath = (root, target) => join(root, "deploy", target, "deployment.json");

export async function readReceipt(root, target) {
  try {
    return JSON.parse(await readFile(receiptPath(root, target), "utf8"));
  } catch {
    return null;
  }
}

export async function writeReceipt(root, target, receipt) {
  const path = receiptPath(root, target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

/** `--name value` from argv, or undefined. */
export function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
