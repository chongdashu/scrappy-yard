// The game's smoke driver (game.json "smoke"): load it, check its shape, and decide which requests it lets the release make.
// tests/smoke.mjs uses it; tests/release/smoke-driver.test.mjs checks it without a browser.
//
// A driver default-exports (every field optional):
//   play             selector for the menu entry pressed for Play (both sessions)
//   desktop, phone   { query?, play?, drive(t) }: the game's own round, played with real input
//   allowedOrigins   origins of the game's own fixtures (a local game server it starts): loopback only
//   sharedWorld      true when remote state goes on while the local round is paused, so stats may change during pause
//   cleanup()        async: stop what the driver started; awaited after the run, whether it passed or not
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Check a driver's default export; returns it with `allowedOrigins` as origins and `sharedWorld` as a boolean. Throws naming `where`. */
export function checkSmokeDriver(raw, where = "the smoke driver") {
  const d = raw ?? {};
  if (typeof d !== "object" || Array.isArray(d)) throw new Error(`${where} must default-export an object.`);
  if (d.play !== undefined && (typeof d.play !== "string" || !d.play)) throw new Error(`${where} "play" must be a selector.`);
  for (const name of ["desktop", "phone"]) {
    const plan = d[name];
    if (plan === undefined) continue;
    if (!plan || typeof plan !== "object") throw new Error(`${where} "${name}" must be an object { query?, play?, drive(t) }.`);
    if (plan.drive !== undefined && typeof plan.drive !== "function") throw new Error(`${where} "${name}.drive" must be a function.`);
  }
  if (d.sharedWorld !== undefined && typeof d.sharedWorld !== "boolean") throw new Error(`${where} "sharedWorld" must be true or false.`);
  if (d.cleanup !== undefined && typeof d.cleanup !== "function") throw new Error(`${where} "cleanup" must be a function.`);
  if (d.allowedOrigins !== undefined && !Array.isArray(d.allowedOrigins)) throw new Error(`${where} "allowedOrigins" must be a list of origins.`);
  const allowedOrigins = (d.allowedOrigins ?? []).map((o) => {
    let url = null;
    try {
      url = new URL(o);
    } catch {}
    if (!url || !/^(http|ws)s?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error(`${where} "allowedOrigins" entries must be origins such as "http://127.0.0.1:2567" (got ${JSON.stringify(o)}).`);
    }
    // Isolated fixtures only: a hosted backend (a playtest or production server) stays a leak even when a driver lists it.
    if (!LOOPBACK.has(url.hostname)) throw new Error(`${where} "allowedOrigins" may only name local fixtures (127.0.0.1, localhost, [::1]); got ${url.origin}.`);
    return httpOrigin(url.href);
  });
  return { ...d, allowedOrigins, sharedWorld: d.sharedWorld === true };
}

/** A URL's origin with ws(s): read as http(s):, so a WebSocket and its HTTP handshake count as one origin. */
const httpOrigin = (href) => {
  const url = new URL(href);
  if (url.protocol === "ws:" || url.protocol === "wss:") url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  return url.origin;
};

/** Is this request a leak? Any http(s) or ws(s) URL whose origin is neither the release server's nor one the driver allows. */
export function isForeignRequest(href, serverBase, allowedOrigins = []) {
  if (!/^(http|ws)s?:/.test(href)) return false; // data:, blob:, chrome-extension: and the like never leave the machine
  const origin = httpOrigin(href);
  return origin !== new URL(serverBase).origin && !allowedOrigins.includes(origin);
}

/** Import and check the active game's driver (`game.json` "smoke"); an empty driver when it declares none. */
export async function loadSmokeDriver(active) {
  if (!active.manifest.smoke) return checkSmokeDriver({});
  const where = `${active.dir}/${active.manifest.smoke}`;
  const mod = await import(pathToFileURL(join(active.abs, active.manifest.smoke)).href);
  try {
    return checkSmokeDriver(mod.default, where);
  } catch (e) {
    await mod.default?.cleanup?.(); // it may have started a fixture at import
    throw e;
  }
}
