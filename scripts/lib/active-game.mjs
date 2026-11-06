// The active game: the one folder the engine builds, serves, packages and tests.
//
//   game.config.json   { "gameDir": "game" }                  the default: your game in game/
//   GAME_DIR=addons/starter-arena npm run dev                 one command with another game (CI, tests, an add-on)
//
// Everything game-specific derives from it:
//   <gameDir>/game.json          identity (id, title, storagePrefix, version), the release asset
//                                allowlist, the preview model list, optional commands, the smoke driver,
//                                and the host services the game opts into (platform)
//   <gameDir>/src/index.ts       the `@game` alias: the one way engine code reaches game code
//   <gameDir>/public/            the web root Vite serves and the packager takes assets from
//   <gameDir>/crate/             the crate `npm run wasm` builds → <gameDir>/public/wasm/sim.wasm
//   game.json "vite"             optional: a module in the game folder whose default export adds Vite plugins
//                                (a game's own dev server or middleware) to dev, build, preview, packaging and tests
//   game.json "bootStyle"        optional: a .css file in the game folder inlined into index.html's critical styles,
//                                so the first paint is already the game's loading screen
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Names that become directories under release/ and dist/ (and recursive deletes): never empty, never a path. */
export const SAFE_NAME = /^[a-z][a-z0-9-]*$/;
/** Saved keys are `<storagePrefix>:<name>:v<N>` (src/platform/storage-key.ts). */
const STORAGE_PREFIX = /^[a-z0-9][a-z0-9._-]*$/i;

const readJson = (path, what) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${what} not found: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${e.message}`);
  }
};

/** The active game folder, relative to the project root with forward slashes (e.g. "game"). */
export function activeGameDir(root = ROOT, env = process.env) {
  let dir = env.GAME_DIR?.trim();
  let from = "GAME_DIR";
  if (!dir) {
    const path = join(root, "game.config.json");
    const cfg = existsSync(path) ? readJson(path, "game.config.json") : {};
    dir = cfg.gameDir ?? "game";
    from = 'game.config.json "gameDir"';
  }
  const rel = relative(root, resolve(root, dir)).split(sep).join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${from} must name a folder inside the project (got ${JSON.stringify(dir)}).`);
  return rel;
}

/** A path in game.json that must name a file inside the game folder (relative, no "..", no absolute path). */
const insideGame = (p) => typeof p === "string" && !!p && !isAbsolute(p) && !p.split(/[\\/]/).includes("..");

/**
 * Validate a game.json and fill defaults. Throws naming the file and the field.
 * Shape: { id, title, storagePrefix, version, release: { assets: [glob] },
 *          preview: { models: [{ label, url }] }, commands: { name: [cmd, ...args] }, smoke?: path, vite?: path, bootStyle?: path,
 *          platform: { wavedash: { paidContent: bool, p2p: bool | { messageSize, maxIncomingMessages, reliable, unreliable } } } }
 */
export function validateGameManifest(raw, where = "game.json") {
  const m = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!m) throw new Error(`${where} must be a JSON object.`);
  if (!SAFE_NAME.test(m.id ?? "")) throw new Error(`${where} "id" must match ${SAFE_NAME} (got ${JSON.stringify(m.id)}).`);
  if (typeof m.title !== "string" || !m.title.trim()) throw new Error(`${where} needs a "title".`);
  if (!STORAGE_PREFIX.test(m.storagePrefix ?? "")) throw new Error(`${where} "storagePrefix" must match ${STORAGE_PREFIX} (got ${JSON.stringify(m.storagePrefix)}).`);
  if (typeof m.version !== "string" || !m.version) throw new Error(`${where} needs a "version" string.`);
  const release = { assets: [], ...(m.release ?? {}) };
  if (!Array.isArray(release.assets) || !release.assets.every((g) => typeof g === "string" && g)) throw new Error(`${where} "release.assets" must be a list of globs over the game's public/ folder.`);
  const preview = { models: [], ...(m.preview ?? {}) };
  if (!Array.isArray(preview.models) || !preview.models.every((x) => typeof x?.label === "string" && typeof x?.url === "string")) throw new Error(`${where} "preview.models" must be a list of { "label", "url" }.`);
  const commands = m.commands ?? {};
  if (typeof commands !== "object" || Array.isArray(commands)) throw new Error(`${where} "commands" must be an object of name → [command, ...args].`);
  for (const [name, run] of Object.entries(commands)) {
    if (!Array.isArray(run) || !run.length || !run.every((a) => typeof a === "string")) throw new Error(`${where} command "${name}" must be a non-empty list of strings: [command, ...args].`);
  }
  if (m.smoke !== undefined && (typeof m.smoke !== "string" || !m.smoke)) throw new Error(`${where} "smoke" must be a path (relative to the game folder) to a smoke driver module.`);
  if (m.vite !== undefined && !insideGame(m.vite)) throw new Error(`${where} "vite" must be a path inside the game folder to a module that default-exports Vite plugins (got ${JSON.stringify(m.vite)}).`);
  if (m.bootStyle !== undefined && !(insideGame(m.bootStyle) && m.bootStyle.endsWith(".css"))) throw new Error(`${where} "bootStyle" must be a path inside the game folder to a .css file (got ${JSON.stringify(m.bootStyle)}).`);
  return { ...m, release, preview, commands, platform: validatePlatform(m.platform, where) };
}

/** P2P limits the Wavedash SDK accepts (docs.wavedash.com/multiplayer/networking); src/platform/wavedash-lobbies.ts clamps to the same. */
const P2P_LIMITS = { messageSize: [45, 65536], maxIncomingMessages: [1, 1 << 20] };

/** The host services a game opts into, every one off unless its game.json says so. Unknown keys fail (a typo would silently leave a service off). */
function validatePlatform(raw, where) {
  const obj = (v, path) => {
    if (v === undefined) return {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} "${path}" must be an object.`);
    return v;
  };
  const only = (v, keys, path) => {
    for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Error(`${where} "${path}" has an unknown key "${k}" (known: ${keys.join(", ")}).`);
  };
  const platform = obj(raw, "platform");
  only(platform, ["wavedash"], "platform");
  const wd = obj(platform.wavedash, "platform.wavedash");
  only(wd, ["paidContent", "p2p"], "platform.wavedash");
  if (wd.paidContent !== undefined && typeof wd.paidContent !== "boolean") throw new Error(`${where} "platform.wavedash.paidContent" must be true or false.`);
  let p2p = wd.p2p ?? false;
  if (typeof p2p !== "boolean") {
    p2p = { ...obj(p2p, "platform.wavedash.p2p") };
    only(p2p, ["messageSize", "maxIncomingMessages", "reliable", "unreliable"], "platform.wavedash.p2p");
    for (const [k, [min, max]] of Object.entries(P2P_LIMITS)) {
      if (p2p[k] !== undefined && !(Number.isInteger(p2p[k]) && p2p[k] >= min && p2p[k] <= max)) throw new Error(`${where} "platform.wavedash.p2p.${k}" must be a whole number from ${min} to ${max} (got ${JSON.stringify(p2p[k])}).`);
    }
    for (const k of ["reliable", "unreliable"]) if (p2p[k] !== undefined && typeof p2p[k] !== "boolean") throw new Error(`${where} "platform.wavedash.p2p.${k}" must be true or false.`);
    if (p2p.reliable === false && p2p.unreliable === false) throw new Error(`${where} "platform.wavedash.p2p" turns off both channel kinds; set "p2p": false instead.`);
  }
  return { wavedash: { paidContent: wd.paidContent ?? false, p2p } };
}

/** The active game: its folder, validated game.json and the paths every tool derives from it. */
export function loadActiveGame(root = ROOT, env = process.env) {
  const dir = activeGameDir(root, env);
  const abs = join(root, dir);
  const manifestPath = join(abs, "game.json");
  if (!existsSync(manifestPath)) {
    const how = env.GAME_DIR?.trim() ? "GAME_DIR" : 'game.config.json "gameDir"';
    throw new Error(`No game at ${dir}/ (from ${how}): ${dir}/game.json is missing.`);
  }
  const manifest = validateGameManifest(readJson(manifestPath, `${dir}/game.json`), `${dir}/game.json`);
  return {
    dir,
    abs,
    manifest,
    entry: join(abs, "src/index.ts"),
    publicDir: join(abs, "public"),
    crateDir: join(abs, "crate"),
    wasmPath: join(abs, "public/wasm/sim.wasm"),
    bootStylePath: manifest.bootStyle === undefined ? null : join(abs, manifest.bootStyle),
  };
}

/** What the page may know about the game (bundled): identity, the preview list and its host-service opt-ins, not build settings. */
export const publicIdentity = (m) => ({ id: m.id, title: m.title, storagePrefix: m.storagePrefix, version: m.version, preview: { models: m.preview.models }, platform: m.platform ?? { wavedash: { paidContent: false, p2p: false } } });

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The end of index.html's critical boot `<style>` block: the first one in `<head>`. */
const CRITICAL_STYLE_END = /^([\s\S]*?<head[\s>][\s\S]*?<style[\s>][\s\S]*?)(<\/style>)/i;
/** The engine's loading screen (`<section id="boot">` in index.html): only a page that has it gets the game's boot styles. */
const BOOT_SCREEN = /<[a-z][^>]*\sid=(["']?)boot\1[\s>]/i;

/**
 * Put a game's boot CSS (game.json "bootStyle") at the end of the page's critical `<style>` block, after the engine's
 * rules, so the loading screen is the game's from the first paint. Throws, naming `where`, when the CSS could close the
 * block or the page has no `<style>` in its `<head>` (a changed index.html must not drop the splash silently).
 */
export function inlineBootStyle(html, css, where = 'game.json "bootStyle"') {
  if (/<\/style/i.test(css)) throw new Error(`${where} must not contain "</style".`);
  const head = html.match(/<head[\s>][\s\S]*?<\/head>/i)?.[0] ?? "";
  if (!CRITICAL_STYLE_END.test(html) || !/<style[\s>]/i.test(head)) throw new Error(`${where}: index.html has no <style> block in its <head> to put the boot styles in.`);
  return html.replace(CRITICAL_STYLE_END, (_, before, end) => `${before}${css.trimEnd()}\n    ${end}`);
}

/**
 * Vite settings for the active game, shared by vite.config.ts and the release packager (which
 * builds with `configFile: false`):
 * - `@game` → <gameDir>/src/index.ts (engine code's only door into game code);
 * - `@engine/…` → src/… (how game code imports the engine, from game/ or addons/<name>/ alike);
 * - `__GAME__` → the public identity from game.json (src/config.ts);
 * - `%GAME_TITLE%` in index.html → the game's title;
 * - game.json "bootStyle" → inlined at the end of index.html's critical `<style>`, so the loading screen is the game's own from
 *   the first paint (its other CSS arrives with its code, seconds later on a slow line); read per request, so dev picks up edits.
 *   Only a page with the loading screen (`id="boot"`) gets it: the plugin sees every page, and preview.html has no `<style>`;
 * - the game's public/ as the web root.
 */
export function viteGameConfig(game, root = ROOT) {
  const title = escapeHtml(game.manifest.title);
  const bootStyle = game.bootStylePath ?? null;
  const where = `${game.dir}/game.json "bootStyle" (${game.dir}/${game.manifest.bootStyle})`;
  const readBootStyle = () => {
    try {
      return readFileSync(bootStyle, "utf8");
    } catch (e) {
      throw new Error(`${where} could not be read: ${e.code === "ENOENT" ? "not found" : e.message}.`);
    }
  };
  return {
    publicDir: game.publicDir,
    resolve: {
      alias: [
        { find: /^@game$/, replacement: game.entry },
        { find: /^@engine\//, replacement: `${join(root, "src")}/` },
      ],
    },
    define: { __GAME__: JSON.stringify(publicIdentity(game.manifest)) },
    plugins: [
      {
        name: "vgd-active-game-html",
        transformIndexHtml: {
          order: "pre",
          handler: (html) => {
            html = html.replaceAll("%GAME_TITLE%", title);
            return bootStyle && BOOT_SCREEN.test(html) ? inlineBootStyle(html, readBootStyle(), where) : html;
          },
        },
      },
    ],
  };
}

/**
 * The active game's own Vite plugins (game.json "vite"): [] when it declares none. The module default-exports a plugin list, or a
 * function `(env) => plugins` (sync or async) that gets Vite's config env (`{ command: "serve" | "build", mode, isPreview? }`) plus
 * `{ game }` (this resolver's view of the game). Every engine entry point applies them: vite.config.ts (dev, build, preview,
 * Vitest), the release packager and the browser fixtures. A plugin limits itself with Vite's own `apply: "serve" | "build"`.
 */
export async function gameVitePlugins(game, env = { command: "build", mode: "production" }) {
  const rel = game.manifest.vite;
  if (rel === undefined) return [];
  const path = join(game.abs, rel);
  const where = `${game.dir}/game.json "vite" (${game.dir}/${rel})`;
  if (!existsSync(path)) throw new Error(`${where} not found.`);
  const mod = await import(pathToFileURL(path).href);
  let plugins = mod.default;
  if (typeof plugins === "function") plugins = await plugins({ ...env, game });
  if (!Array.isArray(plugins)) throw new Error(`${where} must default-export a list of Vite plugins or a function returning one.`);
  return plugins.flat(Infinity).filter(Boolean);
}
