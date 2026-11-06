// Minimal Chrome DevTools Protocol driver: launches headless Chrome (always
// muted: an owner once heard invisible test runs) and talks to it over Node's
// built-in WebSocket. No puppeteer. Input sent with Input.dispatch* is trusted.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME_BIN ?? (
  process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
  : "google-chrome"
);

/** Launch headless Chrome; resolves with the browser WebSocket URL and a close() that cleans up. */
export async function launchChrome({ width = 1280, height = 720, headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "vgd-smoke-"));
  const args = [
    ...(headless ? ["--headless=new"] : []),
    "--mute-audio", // always: headless runs must never be audible
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${width},${height}`,
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-500)}`)), 20000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)));
  });
  const close = async () => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise((r) => { proc.once("exit", r); setTimeout(r, 3000); });
    }
    // Chrome helpers can finish writing the profile just after the parent exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { wsUrl, proc, close };
}

/**
 * Event listeners for a CDP connection. `on(fn)` hears every event as the raw message (`fn({ method, params, sessionId })`);
 * `on(method, fn)` hears one method, as its params (`fn(params, message)`). Both return an unsubscribe function. Anything else
 * throws a TypeError: a listener that is never called would let a check for page errors pass without checking anything.
 * `accept(message)` limits a registry to one session.
 */
export function eventListeners(accept = () => true) {
  const all = [];
  const on = (method, fn) => {
    if (typeof method === "function" && fn === undefined) [method, fn] = [null, method];
    if (typeof fn !== "function" || (method !== null && (typeof method !== "string" || !method))) {
      throw new TypeError(`cdp on(): pass a listener for every event, on(fn), or one method and its listener, on("Domain.event", fn) (got ${typeof method}, ${typeof fn})`);
    }
    const entry = method === null ? fn : (m) => m.method === method && fn(m.params, m);
    all.push(entry);
    return () => {
      const i = all.indexOf(entry);
      if (i >= 0) all.splice(i, 1);
    };
  };
  const emit = (m) => {
    if (accept(m)) for (const l of [...all]) l(m);
  };
  return { on, emit };
}

/** Connect to the browser endpoint; `attach(targetId)` gives a session-bound helper. */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const browser = eventListeners();
  const sessions = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : resolve(msg.result);
    } else if (msg.method) for (const l of [browser, ...sessions]) l.emit(msg);
  });
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    send,
    /** Every event on the connection, any session: on(fn) or on(method, fn) (see eventListeners). */
    on: browser.on,
    close: () => ws.close(),
    async pages() {
      const { targetInfos } = await send("Target.getTargets");
      return targetInfos.filter((t) => t.type === "page");
    },
    /** Attach to a page target (flattened session). */
    async attach(targetId) {
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const S = (method, params) => send(method, params, sessionId);
      const evalJS = async (expression) => {
        const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
      };
      const waitFor = async (expression, timeout = 30000, label = expression) => {
        const t0 = Date.now();
        for (;;) {
          try {
            if (await evalJS(expression)) return;
          } catch { /* page not ready */ }
          if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const events = eventListeners((m) => m.sessionId === sessionId);
      sessions.push(events);
      /** This page's events: on(fn) or on(method, fn) (see eventListeners). */
      return { sessionId, S, evalJS, waitFor, on: events.on };
    },
  };
}
