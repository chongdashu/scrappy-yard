// Serve a frozen package under a nested URL prefix, the way hosts do, and log every miss: a
// root-absolute path or an asset missing from the allowlist shows up here instead of only on
// the live host. A root-only local server hides both.
//   node scripts/serve-release.mjs [target] [--port 5190] [--isolated]
//   → http://127.0.0.1:5190/builds/<game id>/   misses: http://127.0.0.1:5190/__misses
// --isolated adds COOP/COEP headers, approximating a cross-origin-isolated host iframe:
// third-party resources without CORP/CORS headers then fail here too.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { ROOT, SAFE_NAME, argValue, loadActiveGame, releasePaths } from "./lib/release-config.mjs";

const args = process.argv.slice(2);
const target = args[0] && !args[0].startsWith("--") ? args[0] : "web";
if (!SAFE_NAME.test(target)) throw new Error(`Invalid target: ${target}`);
const port = Number(argValue(args, "--port") ?? 5190);
const isolated = args.includes("--isolated");
const game = loadActiveGame().manifest;
const dir = releasePaths(ROOT, target).dir;
if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error(`release/${target} does not exist; run npm run package:${target} first.`);
const prefix = `/builds/${game.id}/`;
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".glb": "model/gltf-binary",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ktx2": "image/ktx2",
};
const misses = [];

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/__misses") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(misses));
  }
  if (path === prefix.slice(0, -1)) {
    res.writeHead(301, { Location: prefix });
    return res.end();
  }
  try {
    if (!path.startsWith(prefix)) throw new Error("outside prefix");
    const rest = path.slice(prefix.length);
    const file = resolve(dir, `./${rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest}`);
    if (!file.startsWith(dir + sep) || !(await stat(file)).isFile()) throw new Error("missing");
    const headers = { "Content-Type": mime[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" };
    if (isolated) Object.assign(headers, { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    if (path !== "/favicon.ico") {
      misses.push(path);
      console.warn(`miss: ${path}`);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`release/${target} at http://127.0.0.1:${port}${prefix}${isolated ? " (cross-origin isolated)" : ""}\nmisses: http://127.0.0.1:${port}/__misses`));
