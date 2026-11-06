import { describe, expect, it, vi } from 'vitest';
import type { SaveStore } from '../src/platform';
import { storageKey } from '../src/platform/storage-key';
import { VersionedSave } from '../src/save';

interface Progress {
  level: number;
  best: number;
  unlocked: string[];
}
const KNOWN = ['a', 'b'];
const fresh = (): Progress => ({ level: 1, best: 0, unlocked: ['a'] });
const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const sanitize = (raw: unknown, d: Progress): Progress => {
  const r = (raw ?? {}) as Partial<Progress>;
  return {
    level: Math.round(num(r.level, 1, 99, d.level)),
    best: num(r.best, 0, Number.MAX_SAFE_INTEGER, d.best),
    unlocked: [...new Set([...d.unlocked, ...(Array.isArray(r.unlocked) ? r.unlocked.filter((id) => KNOWN.includes(id)) : [])])],
  };
};
const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const slot = (store: SaveStore | null, extra: Partial<ConstructorParameters<typeof VersionedSave<Progress>>[0]> = {}) =>
  new VersionedSave<Progress>({ name: 'progress', version: 2, fresh, sanitize, storage: () => store, ...extra });

describe('VersionedSave', () => {
  it('uses a prefixed, versioned key and starts fresh when nothing is saved', () => {
    const s = slot(memory());
    expect(s.key).toBe(storageKey('progress', 2));
    expect(s.data).toEqual(fresh());
  });

  it('round-trips through storage', () => {
    const store = memory();
    const s = slot(store);
    s.update((d) => {
      d.level = 4;
      d.unlocked.push('b');
    });
    expect(slot(store).data).toEqual({ level: 4, best: 0, unlocked: ['a', 'b'] });
  });

  it('sanitizes what it loads: clamps numbers, drops unknown ids, fills missing fields', () => {
    const store = memory({ [storageKey('progress', 2)]: JSON.stringify({ level: 1e9, best: 'lots', unlocked: ['b', 'zzz'] }) });
    expect(slot(store).data).toEqual({ level: 99, best: 0, unlocked: ['a', 'b'] });
  });

  it('falls back to fresh on corrupt JSON, a throwing sanitizer, or blocked storage, without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(slot(memory({ [storageKey('progress', 2)]: '{not json' })).data).toEqual(fresh());
    const throwing = slot(memory({ [storageKey('progress', 2)]: '{}' }), { sanitize: () => { throw new Error('bad'); } });
    expect(throwing.data).toEqual(fresh());
    const blocked: SaveStore = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
    const s = slot(blocked);
    expect(s.data).toEqual(fresh());
    expect(s.save()).toBe(false);
    expect(slot(null).save()).toBe(false);
    warn.mockRestore();
  });

  it('migrates the newest older version once, and ignores older keys after that', () => {
    const store = memory({ [storageKey('progress', 1)]: JSON.stringify({ stage: 3 }) });
    const migrate = vi.fn((from: number, raw: unknown) => (from === 1 ? { level: (raw as { stage: number }).stage } : undefined));
    const s = slot(store, { migrate });
    expect(s.data.level).toBe(3);
    s.save();
    expect(slot(store, { migrate }).data.level).toBe(3);
    expect(migrate).toHaveBeenCalledTimes(1); // the second load found the v2 key
  });

  it('reads storage at use time (hosts swap their store during init)', () => {
    let store: SaveStore | null = null;
    const s = new VersionedSave<Progress>({ name: 'progress', version: 2, fresh, sanitize, storage: () => store });
    store = memory({ [storageKey('progress', 2)]: JSON.stringify({ level: 7 }) });
    expect(s.data.level).toBe(7);
  });

  it('reset writes fresh data rather than deleting, so host stores sync it', () => {
    const store = memory();
    const s = slot(store);
    s.update((d) => (d.level = 9));
    expect(s.reset()).toBe(true);
    expect(JSON.parse(store.m.get(s.key)!)).toEqual(fresh());
  });
});
