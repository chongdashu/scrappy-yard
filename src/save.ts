// A versioned save slot. The key carries the version (`<storagePrefix>:<name>:v<N>`), so an
// incompatible shape change bumps the version instead of loading a stale snapshot; older
// versions can be carried over once by `migrate`. Every read and write is guarded: private
// windows, blocked storage, a full quota or corrupt JSON fall back to `fresh()` and never
// throw into the game. Construct and first read it after `await platform.init()` (hosts such
// as Wavedash restore the cloud copy there).
import { platform, storageKey, type SaveStore } from "./platform";

export interface VersionedSaveOptions<T> {
  /** Slot name, e.g. "progress" or "settings". */
  name: string;
  /** Current version (1+). */
  version: number;
  /** A new, valid value; called for every fallback, so return a fresh object each time. */
  fresh: () => T;
  /** Turn parsed JSON of the current version into a valid T (clamp numbers, drop unknown ids). */
  sanitize: (raw: unknown, fresh: T) => T;
  /** Parsed JSON saved under an older version → current-version raw data, or undefined to skip it. */
  migrate?: (fromVersion: number, raw: unknown) => unknown;
  /** Where to read and write; read at each use. Defaults to `platform.storage`. */
  storage?: () => SaveStore | null;
}

export class VersionedSave<T> {
  readonly key: string;
  private cached: T | null = null;
  private readonly store: () => SaveStore | null;

  constructor(private readonly opts: VersionedSaveOptions<T>) {
    this.key = storageKey(opts.name, opts.version);
    this.store = opts.storage ?? (() => platform.storage);
  }

  /** The current value, loaded on first use. Mutate it, then call save(). */
  get data(): T {
    return (this.cached ??= this.load());
  }

  /** Read storage again (discarding unsaved changes). */
  load(): T {
    const { fresh, sanitize, migrate, version, name } = this.opts;
    let value = fresh();
    try {
      const raw = this.read(this.key);
      if (raw !== undefined) {
        value = sanitize(raw, fresh());
      } else if (migrate) {
        for (let v = version - 1; v >= 1; v--) {
          const old = this.read(storageKey(name, v));
          if (old === undefined) continue;
          const carried = migrate(v, old);
          if (carried !== undefined) value = sanitize(carried, fresh());
          break;
        }
      }
    } catch (e) {
      console.warn(`[save] ${this.key} unreadable; starting fresh`, e);
      value = fresh();
    }
    return (this.cached = value);
  }

  /** Persist the current value. Returns false when storage refused it (the game carries on). */
  save(): boolean {
    try {
      const store = this.store();
      if (!store) return false;
      store.setItem(this.key, JSON.stringify(this.data));
      return true;
    } catch (e) {
      console.warn(`[save] ${this.key} not saved`, e);
      return false;
    }
  }

  /** Change the value and save it in one step. */
  update(change: (data: T) => void): boolean {
    change(this.data);
    return this.save();
  }

  /** Back to `fresh()`, saved (a write rather than a delete, so host stores sync it). */
  reset(): boolean {
    this.cached = this.opts.fresh();
    return this.save();
  }

  private read(key: string): unknown {
    let text: string | null = null;
    try {
      text = this.store()?.getItem(key) ?? null;
    } catch {
      return undefined;
    }
    if (text === null) return undefined;
    return JSON.parse(text) as unknown; // a throw here means corrupt JSON: load() falls back
  }
}
