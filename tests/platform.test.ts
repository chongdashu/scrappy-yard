// Host adapters against fake SDKs (no network, no real host). What these prove: adapter
// behaviour (loading bar, gameplay events, saves, mute, ads, fullscreen policy, cloud-save
// safety). What they don't: a real host page, real ads, or real Wavedash Remote Storage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudSave, type CloudFiles } from '../src/platform/cloud-save';
import { createCrazyGamesPlatform } from '../src/platform/crazygames';
import { STORAGE_PREFIX, isGameKey, storageKey } from '../src/platform/storage-key';
import { createWavedashPlatform } from '../src/platform/wavedash';
import { createWebPlatform } from '../src/platform/web';

/** An in-memory Storage with the parts the adapters use. */
const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};

type Callbacks = { adStarted?: () => void; adFinished?: () => void; adError?: (e: { code: string; message: string }) => void };

/** A stand-in for window.CrazyGames.SDK (v3) that records calls and plays scripted ads. */
function fakeCrazyGames(opts: { environment?: string; muted?: boolean; adblock?: boolean; ad?: (kind: string, cb: Callbacks) => void; dataThrows?: boolean } = {}) {
  const calls: string[] = [];
  const data = new Map<string, string>();
  let settingsListener: ((s: { muteAudio: boolean }) => void) | null = null;
  const sdk = {
    environment: opts.environment ?? 'crazygames',
    init: vi.fn(async () => {}),
    game: {
      gameplayStart: () => calls.push('gameplayStart'),
      gameplayStop: () => calls.push('gameplayStop'),
      loadingStart: () => calls.push('loadingStart'),
      loadingStop: () => calls.push('loadingStop'),
      happytime: () => calls.push('happytime'),
      reportGameCompletedPercentage: (pct: number) => calls.push(`progress:${pct}`),
      settings: { muteAudio: !!opts.muted },
      addSettingsChangeListener: (l: (s: { muteAudio: boolean }) => void) => (settingsListener = l),
    },
    ad: {
      requestAd: (kind: string, cb: Callbacks) => (calls.push(`ad:${kind}`), (opts.ad ?? ((_, c) => (c.adStarted?.(), c.adFinished?.())))(kind, cb)),
      hasAdblock: async () => !!opts.adblock,
    },
    data: {
      getItem: (k: string) => {
        if (opts.dataThrows) throw new Error('dataModuleDisabled');
        return data.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.dataThrows) throw new Error('dataModuleDisabled');
        data.set(k, v);
      },
    },
  };
  return { host: { CrazyGames: { SDK: sdk } } as never, calls, data, mute: (m: boolean) => settingsListener?.({ muteAudio: m }) };
}
const hooks = () => {
  const log: string[] = [];
  return { log, started: () => log.push('started'), ended: () => log.push('ended') };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('storage keys', () => {
  it('prefix every key with the active game.json storagePrefix and a version', () => {
    expect(storageKey('progress')).toBe(`${STORAGE_PREFIX}:progress:v1`);
    expect(storageKey('settings', 3)).toBe(`${STORAGE_PREFIX}:settings:v3`);
    expect(isGameKey(storageKey('x'))).toBe(true);
    expect(isGameKey('someone-else:progress:v1')).toBe(false);
    expect(() => storageKey('a b')).toThrow();
    expect(() => storageKey('ok', 0)).toThrow();
  });
});

describe('CrazyGames adapter', () => {
  it('leaves the optional stats, boards, paid, lobbies and userToken interfaces unimplemented in this adapter', () => {
    const p = createCrazyGamesPlatform({ ads: false, host: fakeCrazyGames().host, loadScript: false });
    expect([p.stats, p.boards, p.paid, p.lobbies, p.userToken]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('reports completion as a whole percent, clamped, only when it changes, and only on CrazyGames', async () => {
    const f = fakeCrazyGames();
    const p = createCrazyGamesPlatform({ ads: false, host: f.host, loadScript: false });
    p.reportProgress!(10); // before init: no SDK yet
    await p.init();
    p.reportProgress!(24.6); p.reportProgress!(25.2); p.reportProgress!(140); p.reportProgress!(-3);
    expect(f.calls.filter((c) => c.startsWith('progress:'))).toEqual(['progress:25', 'progress:100', 'progress:0']);
    const elsewhere = fakeCrazyGames({ environment: 'disabled' });
    const q = createCrazyGamesPlatform({ ads: false, host: elsewhere.host, loadScript: false });
    await q.init();
    q.reportProgress!(50);
    expect(elsewhere.calls).toEqual([]);
  });

  it('disables first-party analytics by policy and the prohibited custom fullscreen button', async () => {
    const p = createCrazyGamesPlatform({ ads: true, loadScript: false });
    expect([p.ownAnalytics, p.ownFullscreen]).toEqual([false, false]);
    expect(await p.toggleFullscreen()).toBe(false);
  });

  it('reports loading and deduplicated gameplay start/stop, and celebrates', async () => {
    const f = fakeCrazyGames();
    const p = createCrazyGamesPlatform({ ads: false, host: f.host, loadScript: false });
    await p.init();
    p.ready();
    p.gameplayStart(); p.gameplayStart(); p.gameplayStop(); p.gameplayStop(); p.gameplayStart();
    p.celebrate();
    expect(f.calls).toEqual(['loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart', 'happytime']);
  });

  it('saves through the Data module, falling back to localStorage when it is disabled', async () => {
    const local = memory();
    vi.stubGlobal('localStorage', local);
    const f = fakeCrazyGames();
    const p = createCrazyGamesPlatform({ ads: false, host: f.host, loadScript: false });
    await p.init();
    p.storage!.setItem('k1', '{"v":1}');
    expect(f.data.get('k1')).toBe('{"v":1}');
    expect(local.m.has('k1')).toBe(false);
    const g = fakeCrazyGames({ dataThrows: true });
    const q = createCrazyGamesPlatform({ ads: false, host: g.host, loadScript: false });
    await q.init();
    q.storage!.setItem('k2', 'v');
    expect(q.storage!.getItem('k2')).toBe('v');
    expect(local.m.get('k2')).toBe('v');
  });

  it("follows the host's mute setting", async () => {
    const f = fakeCrazyGames({ muted: true });
    const p = createCrazyGamesPlatform({ ads: false, host: f.host, loadScript: false });
    await p.init();
    expect(p.hostMuted).toBe(true);
    const seen: boolean[] = [];
    p.onHostMute((m) => seen.push(m));
    f.mute(false);
    expect([p.hostMuted, seen]).toEqual([false, [false]]);
  });

  it('plays ads only when the build allows them, and grants only a finished ad', async () => {
    const off = createCrazyGamesPlatform({ ads: false, host: fakeCrazyGames().host, loadScript: false });
    await off.init();
    expect(off.canShowAd('rewarded')).toBe(false);
    expect(await off.showAd('rewarded', hooks())).toBe('unavailable');

    const f = fakeCrazyGames();
    const p = createCrazyGamesPlatform({ ads: true, host: f.host, loadScript: false });
    await p.init();
    const h = hooks();
    expect(await p.showAd('rewarded', h)).toBe('done');
    expect(h.log).toEqual(['started', 'ended']);
  });

  it('carries on quietly when no ad fills, and stops offering after Basic Launch or ad-block errors', async () => {
    let code = 'unfilled';
    const f = fakeCrazyGames({ ad: (_, cb) => cb.adError?.({ code, message: 'x' }) });
    const p = createCrazyGamesPlatform({ ads: true, host: f.host, loadScript: false });
    await p.init();
    const h = hooks();
    expect(await p.showAd('midgame', h)).toBe('unavailable');
    expect(h.log).toEqual([]); // never started, so nothing to restore
    expect(p.canShowAd('rewarded')).toBe(true); // a no-fill is not a reason to hide offers
    code = 'adsDisabledBasicLaunch';
    expect(await p.showAd('rewarded', hooks())).toBe('unavailable');
    expect(p.canShowAd('rewarded')).toBe(false); // hidden for the rest of the visit
    expect(await p.showAd('rewarded', hooks())).toBe('unavailable');
    expect(f.calls.filter((c) => c.startsWith('ad:'))).toHaveLength(2);
  });

  it('reports an ad that never answers as an error, and still restores the game', async () => {
    vi.useFakeTimers();
    const f = fakeCrazyGames({ ad: (_, cb) => cb.adStarted?.() });
    const p = createCrazyGamesPlatform({ ads: true, host: f.host, loadScript: false });
    await p.init();
    const h = hooks();
    const result = p.showAd('rewarded', h);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await result).toBe('error');
    expect(h.log).toEqual(['started', 'ended']);
  });

  it('turns ads off for ad-block users and stays inert off CrazyGames', async () => {
    const blocked = createCrazyGamesPlatform({ ads: true, host: fakeCrazyGames({ adblock: true }).host, loadScript: false });
    await blocked.init();
    expect(blocked.canShowAd('rewarded')).toBe(false);
    const f = fakeCrazyGames({ environment: 'disabled' });
    const elsewhere = createCrazyGamesPlatform({ ads: true, host: f.host, loadScript: false });
    await elsewhere.init();
    elsewhere.gameplayStart();
    expect(elsewhere.canShowAd('midgame')).toBe(false);
    expect(f.calls).toEqual([]);
    const none = createCrazyGamesPlatform({ ads: true, host: {} as never, loadScript: false });
    await none.init();
    expect(none.canShowAd('rewarded')).toBe(false);
  });
});

describe('Wavedash and web adapters', () => {
  it('Wavedash: forward-only loading bar, init once, loadComplete only when boot fails first', async () => {
    const calls: unknown[] = [];
    const sdk = {
      updateLoadProgressZeroToOne: (p: number) => calls.push(['progress', p]),
      init: () => (calls.push('init'), true),
      loadComplete: () => calls.push('loadComplete'),
    };
    const p = createWavedashPlatform({ Wavedash: Promise.resolve(sdk) });
    await p.init();
    p.loading(0.5); p.loading(0.2); p.ready(); p.ready(); p.failed();
    expect(calls).toEqual([['progress', 0.5], ['progress', 0.5], ['progress', 1], 'init']);
    expect([p.id, p.ownAnalytics, p.canShowAd('rewarded')]).toEqual(['wavedash', true, false]);

    const failing: unknown[] = [];
    const q = createWavedashPlatform({ Wavedash: { loadComplete: () => failing.push('loadComplete'), init: () => failing.push('init') } });
    await q.init();
    q.failed(); q.ready();
    expect(failing).toEqual(['loadComplete']);
    const none = createWavedashPlatform({});
    await none.init();
    none.ready(); // no SDK: harmless
  });

  it('web: first-party analytics, no ads, fullscreen offered only where the browser supports it', async () => {
    const p = createWebPlatform();
    expect([p.stats, p.boards, p.paid, p.lobbies, p.userToken]).toEqual([undefined, undefined, undefined, undefined, undefined]); // no host services
    expect([p.id, p.ownAnalytics, p.canShowAd('midgame')]).toEqual(['web', true, false]);
    expect(await p.showAd('rewarded', hooks())).toBe('unavailable');
    expect(p.ownFullscreen).toBe(false); // no document in node

    const requested: unknown[] = [];
    vi.stubGlobal('document', {
      fullscreenEnabled: true,
      fullscreenElement: null,
      documentElement: { requestFullscreen: async (o: unknown) => void requested.push(o) },
    });
    const q = createWebPlatform();
    expect(q.ownFullscreen).toBe(true);
    expect(await q.toggleFullscreen()).toBe(true);
    expect(requested).toEqual([{ navigationUI: 'hide' }]);
  });
});

// ---------------------------------------------------------------------------------------
// Cloud save (Wavedash): the safety rules, because the failure mode is silent progress loss.

const STAMP = 'test.cloud-saved-at';
const synced = (k: string) => k.startsWith('g:');
const payload = (savedAt: number, items: Record<string, string>) => JSON.stringify({ v: 1, savedAt, items });
/** A fake cloud: `text` is the stored file (null = none); reads and writes can be made to fail. */
interface FakeCloud {
  text: string | null;
  writes: string[];
  readFails: boolean;
  writeFails: boolean;
  files: CloudFiles;
}
const cloud = (text: string | null, opts: { readFails?: boolean; writeFails?: boolean } = {}) => {
  const f: FakeCloud = {
    text,
    writes: [] as string[],
    readFails: !!opts.readFails,
    writeFails: !!opts.writeFails,
    files: {
      read: async () => (f.readFails ? undefined : f.text),
      write: async (t: string) => {
        if (f.writeFails) return false;
        f.writes.push(t);
        f.text = t;
        return true;
      },
    } as CloudFiles,
  };
  return f;
};
const opts = { synced, stampKey: STAMP, debounceMs: 100, pollMs: 1000, backoffMs: 5000, log: () => {} };

describe('cloud save', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));

  it('a fresh build (empty storage) takes the cloud save and does not upload it back', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":29}', 'g:settings': 'on' }));
    const local = memory();
    const s = createCloudSave(c.files, local, opts);
    expect(await s.restore()).toBe('cloud');
    expect(local.m.get('g:progress')).toBe('{"n":29}');
    expect(local.m.get('g:settings')).toBe('on');
    expect(local.m.get(STAMP)).toBe('900000');
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.writes).toHaveLength(0);
  });

  it('a newer cloud save removes synced keys it no longer has, and ignores foreign keys', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":0}', 'other:x': 'smuggled' }));
    const local = memory({ 'g:progress': '{"n":50}', 'g:settings': 'on', [STAMP]: '800000', other: 'kept' });
    const s = createCloudSave(c.files, local, opts);
    expect(await s.restore()).toBe('cloud');
    expect(local.m.has('g:settings')).toBe(false);
    expect(local.m.get('g:progress')).toBe('{"n":0}');
    expect(local.m.get('other')).toBe('kept');
    expect(local.m.has('other:x')).toBe(false);
  });

  it('a newer local copy wins and is uploaded; only synced keys travel', async () => {
    const c = cloud(payload(800_000, { 'g:progress': '{"n":10}' }));
    const local = memory({ 'g:progress': '{"n":99}', [STAMP]: '900000', unrelated: 'x' });
    const s = createCloudSave(c.files, local, opts);
    expect(await s.restore()).toBe('local');
    await vi.advanceTimersByTimeAsync(10);
    expect(c.writes).toHaveLength(1);
    expect(JSON.parse(c.writes[0]).items).toEqual({ 'g:progress': '{"n":99}' });
  });

  it('no cloud save yet: the local copy is uploaded', async () => {
    const c = cloud(null);
    const s = createCloudSave(c.files, memory({ 'g:progress': '{"n":5}' }), opts);
    expect(await s.restore()).toBe('new');
    await vi.advanceTimersByTimeAsync(10);
    expect(JSON.parse(c.writes[0]).items['g:progress']).toBe('{"n":5}');
  });

  it('when the cloud cannot be read, nothing is ever uploaded (a real save is never overwritten)', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":29}' }), { readFails: true });
    const local = memory();
    const s = createCloudSave(c.files, local, opts);
    expect(await s.restore()).toBe('unavailable');
    local.setItem('g:progress', '{"n":0}');
    s.changed();
    await s.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.writes).toHaveLength(0);
    expect(c.text).toContain('\\"n\\":29');
  });

  it('a read that never answers times out as unavailable', async () => {
    const files: CloudFiles = { read: () => new Promise(() => {}), write: async () => true };
    const s = createCloudSave(files, memory(), opts);
    const r = s.restore(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await r).toBe('unavailable');
  });

  it('changes upload after the debounce; direct writes are caught by the poll', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":1}' }));
    const local = memory();
    const s = createCloudSave(c.files, local, opts);
    await s.restore();
    local.setItem('g:progress', '{"n":2}');
    s.changed();
    await vi.advanceTimersByTimeAsync(99);
    expect(c.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.writes).toHaveLength(1);
    local.setItem('g:settings', 'on'); // written without changed()
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.writes).toHaveLength(2);
    expect(JSON.parse(c.writes[1]).items).toEqual({ 'g:progress': '{"n":2}', 'g:settings': 'on' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.writes).toHaveLength(2); // unchanged: no more uploads
  });

  it('a failed upload stays local-newer and is retried after the backoff', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":1}' }));
    const local = memory();
    const s = createCloudSave(c.files, local, opts);
    await s.restore();
    c.writeFails = true;
    local.setItem('g:progress', '{"n":3}');
    await s.flush();
    expect(Number(local.m.get(STAMP))).toBeGreaterThan(900_000); // next boot, local wins
    c.writeFails = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.writes).toHaveLength(0); // still backing off
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.writes).toHaveLength(1);
  });

  it('a reset (every synced key written fresh) beats the old cloud copy at the next boot, even when its upload failed', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":29}', 'g:career': '{"medals":5}' }));
    const local = memory();
    const s = createCloudSave(c.files, local, opts);
    expect(await s.restore()).toBe('cloud');
    // The player starts over: the game writes fresh saves, then flushes; the upload fails (offline, say).
    c.writeFails = true;
    local.setItem('g:progress', '{"n":0}');
    local.setItem('g:career', '{"medals":0,"resetAt":1000000}');
    s.changed();
    await s.flush();
    expect(c.text).toContain('\\"n\\":29'); // (the cloud still has the old progress)
    // The next boot on this device: the old cloud file is there, and the reset stays.
    c.writeFails = false;
    const next = createCloudSave(c.files, local, opts);
    expect(await next.restore()).toBe('local');
    expect(local.m.get('g:progress')).toBe('{"n":0}');
    await vi.advanceTimersByTimeAsync(10);
    expect(JSON.parse(c.writes.at(-1)!).items).toEqual({ 'g:progress': '{"n":0}', 'g:career': '{"medals":0,"resetAt":1000000}' });
    // And a device that had nothing now takes the reset from the cloud.
    const other = memory();
    expect(await createCloudSave(c.files, other, opts).restore()).toBe('cloud');
    expect(other.m.get('g:progress')).toBe('{"n":0}');
  });

  it('a reset whose flush reached the cloud is what every later boot sees', async () => {
    const c = cloud(payload(900_000, { 'g:progress': '{"n":29}' }));
    const local = memory();
    const s = createCloudSave(c.files, local, opts);
    await s.restore();
    local.setItem('g:progress', '{"n":0}');
    s.changed();
    await s.flush();
    expect(JSON.parse(c.text!).items['g:progress']).toBe('{"n":0}');
    expect(JSON.parse(c.text!).savedAt).toBe(Number(local.m.get(STAMP)));
    expect(await createCloudSave(c.files, local, opts).restore()).toBe('local'); // (same stamp: nothing to take)
    const other = memory({ 'g:progress': '{"n":12}', [STAMP]: '950000' });
    expect(await createCloudSave(c.files, other, opts).restore()).toBe('cloud');
    expect(other.m.get('g:progress')).toBe('{"n":0}');
  });

  it('an unreadable cloud file is replaced by the local copy', async () => {
    const c = cloud('not json');
    const s = createCloudSave(c.files, memory({ 'g:progress': '{"n":7}' }), opts);
    expect(await s.restore()).toBe('new');
    await vi.advanceTimersByTimeAsync(10);
    expect(JSON.parse(c.writes[0]).items['g:progress']).toBe('{"n":7}');
  });
});

describe('Wavedash adapter saves', () => {
  /** A fake Wavedash SDK with Remote Storage: `remote` is the cloud, `localFiles` the SDK's local store. */
  const fakeWavedash = (remote: Map<string, Uint8Array>, flags: { downloadFails?: boolean; existsFails?: boolean } = {}) => {
    const localFiles = new Map<string, Uint8Array>();
    return {
      writeLocalFile: async (p: string, d: Uint8Array) => (localFiles.set(p, d), true),
      readLocalFile: async (p: string) => localFiles.get(p) ?? null,
      uploadRemoteFile: async (p: string) => (remote.set(p, localFiles.get(p)!), { success: true, data: p }),
      downloadRemoteFile: async (p: string) => {
        if (flags.downloadFails || !remote.has(p)) return { success: false, data: null, message: 'nope' };
        localFiles.set(p, remote.get(p)!);
        return { success: true, data: p };
      },
      remoteFileExists: async (p: string) => (flags.existsFails ? { success: false, data: null, message: 'x' } : { success: true, data: remote.has(p) }),
    };
  };
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b));
  const FILE = 'saves/progress.json';
  const PROGRESS = storageKey('progress');
  const SETTINGS = storageKey('settings');
  let storage: ReturnType<typeof memory>;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    storage = memory();
    vi.stubGlobal('localStorage', storage);
  });

  it('restores every game key into localStorage during init, before the game reads it', async () => {
    const remote = new Map([[FILE, enc(payload(900_000, { [PROGRESS]: '{"n":29}', [SETTINGS]: 'on' }))]]);
    const p = createWavedashPlatform({ Wavedash: fakeWavedash(remote) });
    await p.init();
    expect(p.storage?.getItem(PROGRESS)).toBe('{"n":29}');
    expect(storage.m.get(SETTINGS)).toBe('on');
  });

  it('saves through platform.storage reach the cloud; keys without the game prefix do not', async () => {
    const remote = new Map<string, Uint8Array>();
    const p = createWavedashPlatform({ Wavedash: fakeWavedash(remote) });
    await p.init();
    storage.setItem('unrelated', 'x');
    p.storage?.setItem(PROGRESS, '{"n":42}');
    await vi.advanceTimersByTimeAsync(2000);
    expect(dec(remote.get(FILE)).items).toEqual({ [PROGRESS]: '{"n":42}' });
  });

  it('a failed download with an existing file is treated as unreadable, not as "no save"', async () => {
    const remote = new Map([[FILE, enc(payload(900_000, { [PROGRESS]: '{"n":29}' }))]]);
    const p = createWavedashPlatform({ Wavedash: fakeWavedash(remote, { downloadFails: true }) });
    await p.init();
    p.storage?.setItem(PROGRESS, '{"n":0}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dec(remote.get(FILE)).items[PROGRESS]).toBe('{"n":29}');
  });

  it('when neither the download nor the existence check answers, nothing is uploaded', async () => {
    const remote = new Map<string, Uint8Array>();
    const p = createWavedashPlatform({ Wavedash: fakeWavedash(remote, { downloadFails: true, existsFails: true }) });
    await p.init();
    p.storage?.setItem(PROGRESS, '{"n":1}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remote.size).toBe(0);
  });
});
