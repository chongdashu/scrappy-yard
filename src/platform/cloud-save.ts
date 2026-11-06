// A cloud copy of the save for hosts that serve every build from its own origin. Wavedash
// does: localStorage starts empty after each update, so without this every release resets
// every player's progress (it happened in production, and only the analytics showed it).
// Every key that belongs to the game (src/platform/storage-key.ts) is mirrored into one JSON
// file in the player's cloud storage. restore() runs in platform.init(), before anything
// reads a save, and copies a newer cloud save into localStorage; after that, changes upload.
//
// Rules that keep it safe (the failure mode is silent, irreversible progress loss):
// - Nothing is uploaded until restore() has read the cloud (a save, or none yet). If the read
//   fails or times out, this visit plays from localStorage and uploads nothing, so a slow
//   network can never replace a real save with an empty one.
// - Newest wins: each side records when it last changed (savedAt, and the stamp key locally).
// - Failures are logged and retried with backoff; nothing here throws into the game.

export interface CloudFiles {
  /** The saved text; null when the player has no cloud save yet; undefined when the read failed. */
  read(): Promise<string | null | undefined>;
  /** True once the text is stored in the cloud. */
  write(text: string): Promise<boolean>;
}

export type LocalStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export type RestoreResult = "cloud" | "local" | "new" | "unavailable";

export interface CloudSave {
  /** Read the cloud and bring localStorage up to date. Resolves within `timeoutMs`; never rejects. */
  restore(timeoutMs?: number): Promise<RestoreResult>;
  /** A synced key may have changed: upload soon (debounced). */
  changed(): void;
  /** Upload now if anything changed (the page is being hidden). */
  flush(): Promise<void>;
}

interface Payload {
  v: 1;
  savedAt: number;
  items: Record<string, string>;
}

export interface CloudSaveOptions {
  /** Which localStorage keys are mirrored. */
  synced: (key: string) => boolean;
  /** Local record of when the synced keys last changed (ms). Never synced itself. */
  stampKey: string;
  now?: () => number;
  debounceMs?: number;
  /** Direct localStorage writes (not through platform.storage) are noticed by polling. */
  pollMs?: number;
  /** First retry after a failed upload; doubles up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export function createCloudSave(files: CloudFiles, local: LocalStore | null, options: CloudSaveOptions): CloudSave {
  const { stampKey } = options;
  const synced = (k: string) => k !== stampKey && options.synced(k);
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? 1500;
  const pollMs = options.pollMs ?? 4000;
  const backoffMs = options.backoffMs ?? 10_000;
  const maxBackoffMs = options.maxBackoffMs ?? 120_000;
  const log = options.log ?? ((m: string, d?: unknown) => console.warn(`[cloud-save] ${m}`, d ?? ""));

  const get = (k: string): string | null => {
    try {
      return local?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const set = (k: string, v: string | null) => {
    try {
      if (v === null) local?.removeItem(k);
      else local?.setItem(k, v);
    } catch {
      /* storage blocked: the cloud copy still holds it */
    }
  };
  const localKeys = (): string[] => {
    const out: string[] = [];
    try {
      for (let i = 0; local && i < local.length; i++) {
        const k = local.key(i);
        if (k !== null && synced(k)) out.push(k);
      }
    } catch {
      /* storage blocked */
    }
    return out.sort(); // a fixed order, so equal saves compare equal
  };
  const items = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of localKeys()) {
      const v = get(k);
      if (v !== null) out[k] = v;
    }
    return out;
  };
  const snapshot = () => JSON.stringify(items());

  let ready = false;
  let sent: string | null = null; // what the cloud holds, as far as we know
  let uploading = false;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let retryAt = 0;
  let backoff = backoffMs;

  const upload = async () => {
    if (!ready) return;
    if (uploading) {
      again = true;
      return;
    }
    if (now() < retryAt) return;
    const snap = snapshot();
    if (snap === sent) return;
    // The local copy changed since the cloud last matched it: stamp it now.
    const savedAt = Math.max(now(), Number(get(stampKey)) || 0);
    set(stampKey, String(savedAt));
    const payload: Payload = { v: 1, savedAt, items: JSON.parse(snap) };
    uploading = true;
    let ok = false;
    try {
      ok = await files.write(JSON.stringify(payload));
    } catch (e) {
      log("upload threw", e);
    }
    uploading = false;
    if (ok) {
      sent = snap;
      backoff = backoffMs;
      retryAt = 0;
    } else {
      log(`upload failed; retrying in ${Math.round(backoff / 1000)} s`);
      retryAt = now() + backoff;
      backoff = Math.min(maxBackoffMs, backoff * 2);
    }
    if (again) {
      again = false;
      void upload();
    }
  };

  const read = async (timeoutMs: number): Promise<string | null | undefined> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), timeoutMs)));
    try {
      return await Promise.race([files.read().catch(() => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const parse = (text: string): Payload | null => {
    try {
      const p = JSON.parse(text) as Partial<Payload>;
      if (p?.v !== 1 || typeof p.savedAt !== "number" || !p.items || typeof p.items !== "object") return null;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.items)) if (synced(k) && typeof v === "string") clean[k] = v;
      return { v: 1, savedAt: p.savedAt, items: clean };
    } catch {
      return null;
    }
  };

  const start = () => {
    ready = true;
    setInterval(() => void upload(), pollMs);
    void upload();
  };

  return {
    async restore(timeoutMs = 4000) {
      const text = await read(timeoutMs);
      if (text === undefined) {
        log("couldn't read the cloud save; playing from this browser's copy without uploading");
        return "unavailable";
      }
      const cloud = text === null ? null : parse(text);
      if (text !== null && !cloud) log("cloud save unreadable; this browser's copy will replace it");
      const localAt = Number(get(stampKey)) || 0;
      let result: RestoreResult;
      if (!cloud) {
        result = "new";
      } else if (cloud.savedAt > localAt) {
        // Newer in the cloud (always so on a fresh build): the synced keys become the cloud's.
        for (const k of localKeys()) if (!(k in cloud.items)) set(k, null);
        for (const [k, v] of Object.entries(cloud.items)) set(k, v);
        set(stampKey, String(cloud.savedAt));
        sent = snapshot();
        result = "cloud";
      } else {
        if (cloud.savedAt === localAt) sent = JSON.stringify(Object.fromEntries(Object.entries(cloud.items).sort(([a], [b]) => (a < b ? -1 : 1))));
        result = "local";
      }
      start();
      return result;
    },
    changed() {
      if (!ready) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void upload();
      }, debounceMs);
    },
    async flush() {
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      retryAt = 0; // the page is going away: one more try now
      await upload();
    },
  };
}
