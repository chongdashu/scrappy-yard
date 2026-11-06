// The Wavedash adapter's stats and achievements, leaderboards, Paid Content, and Lobbies with P2P against the fake SDK in tests/lib/fake-wavedash.mjs (no network, no
// host). What these prove: the adapter's queue-and-retry, id caching, clamping and grant handling, and its lobby bookkeeping (create never
// joins twice, event order, host-only metadata, the P2P opt-in). What they don't: the real host, the real checkout, how the real SDK reports a
// locked file, or a real WebRTC mesh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWavedash, createFakeWavedashHub } from './lib/fake-wavedash.mjs';
import { createWavedashPlatform } from '../src/platform/wavedash';
import { RETRIES, RETRY_MS, clampMeta, createWavedashServices } from '../src/platform/wavedash-services';
import type { WavedashSdk } from '../src/platform/wavedash-sdk';
import type { BoardDef, LobbyState, P2PPeerEvent } from '../src/platform/types';
import { LOBBY_MESSAGE_MAX, P2P_DEFAULTS, createWavedashLobbies, p2pConfig } from '../src/platform/wavedash-lobbies';
import type { WavedashOptions } from '../src/platform/wavedash';
import { publicIdentity, validateGameManifest } from '../scripts/lib/active-game.mjs';

const asSdk = (fake: unknown) => fake as WavedashSdk;
const NET: BoardDef = { name: 'high-score', sort: 'desc', display: 'numeric' };
const FAST: BoardDef = { name: 'fastest-round', sort: 'asc', display: 'milliseconds' };

/** Let the fake's timer-based replies through, then resolve the promise (timers are faked in this file). */
const settle = async <T>(p: Promise<T>): Promise<T> => {
  await vi.advanceTimersByTimeAsync(1);
  return p;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stats and achievements', () => {
  it('holds writes until the host has loaded its stats, then delivers them', async () => {
    const fake = createFakeWavedash({ statsDelayMs: 500, stats: ['POINTS_TOTAL'], achievements: ['FIRST_SCORE'] });
    const { stats } = createWavedashServices(() => asSdk(fake));
    expect(stats.setStat('POINTS_TOTAL', 3)).toBe(true); // accepted (queued), not yet on the host
    expect(stats.unlock('FIRST_SCORE')).toBe(true);
    expect(fake.__wd.state.stats.POINTS_TOTAL).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.__wd.state.stats.POINTS_TOTAL).toBe(3);
    expect(fake.__wd.state.achievements.FIRST_SCORE).toBe(true);
    expect(stats.isUnlocked('FIRST_SCORE')).toBe(true);
    expect(fake.__wd.calls('requestStats')).toHaveLength(1);
  });

  it('keepHighest does not lower a lifetime total or record', async () => {
    const fake = createFakeWavedash({ stats: ['BEST_STREAK'] });
    const { stats } = createWavedashServices(() => asSdk(fake));
    await settle(stats.load());
    fake.__wd.state.stats.BEST_STREAK = 9; // the host already holds a higher value (another device)
    stats.setStat('BEST_STREAK', 2, { keepHighest: true });
    expect(fake.__wd.state.stats.BEST_STREAK).toBe(9);
    stats.setStat('BEST_STREAK', 12, { keepHighest: true });
    expect(fake.__wd.state.stats.BEST_STREAK).toBe(12);
    expect(stats.getStat('BEST_STREAK')).toBe(12);
  });

  it('ordinary stats take the latest absolute value, including decreases', async () => {
    const fake = createFakeWavedash({ statsDelayMs: 500, stats: ['BALANCE'] });
    const { stats } = createWavedashServices(() => asSdk(fake));
    stats.setStat('BALANCE', 12);
    stats.setStat('BALANCE', 4);
    await vi.advanceTimersByTimeAsync(500);
    expect(stats.getStat('BALANCE')).toBe(4);
    stats.setStat('BALANCE', -2);
    expect(stats.getStat('BALANCE')).toBe(-2);
  });

  it('keepHighest also keeps the highest queued value before the host is ready', async () => {
    const fake = createFakeWavedash({ statsDelayMs: 500, stats: ['RECORD'] });
    const { stats } = createWavedashServices(() => asSdk(fake));
    stats.setStat('RECORD', 12, { keepHighest: true });
    stats.setStat('RECORD', 4, { keepHighest: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(stats.getStat('RECORD')).toBe(12);
  });

  it('retries a write the host keeps refusing, then gives up with one warning naming the id', async () => {
    const fake = createFakeWavedash({ achievements: ['REAL_ONE'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stats } = createWavedashServices(() => asSdk(fake));
    await settle(stats.load());
    stats.unlock('NOT_IN_THE_PROJECT');
    await vi.advanceTimersByTimeAsync(RETRY_MS * (RETRIES + 2));
    expect(fake.__wd.calls('setAchievement').length).toBe(RETRIES + 1);
    const named = warn.mock.calls.filter((c) => String(c[0]).includes('NOT_IN_THE_PROJECT'));
    expect(named).toHaveLength(1);
    // a new write starts a fresh round of tries
    stats.unlock('REAL_ONE');
    expect(fake.__wd.state.achievements.REAL_ONE).toBe(true);
  });

  it('loads late stats: writes made before requestStats resolves are delivered once it does, even when it first fails', async () => {
    let calls = 0;
    const fake = createFakeWavedash({ stats: ['POINTS_EARNED'] });
    const real = fake.requestStats as () => Promise<unknown>;
    fake.requestStats = async () => (++calls === 1 ? { success: false, data: null, message: 'down' } : real());
    const { stats } = createWavedashServices(() => asSdk(fake));
    expect(await stats.load()).toBe(false);
    stats.setStat('POINTS_EARNED', 500);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(fake.__wd.state.stats.POINTS_EARNED).toBe(500);
  });

  it('answers false with no host, and never throws', async () => {
    const { stats } = createWavedashServices(() => null);
    expect(await stats.load()).toBe(false);
    expect(stats.setStat('X', 1)).toBe(false);
    expect(stats.unlock('X')).toBe(false);
    expect(stats.isUnlocked('X')).toBe(false);
    expect(stats.getStat('X')).toBe(0);
    expect(() => stats.store()).not.toThrow();
  });

  it('store() asks the host to save now', async () => {
    const fake = createFakeWavedash();
    const { stats } = createWavedashServices(() => asSdk(fake));
    await settle(stats.load());
    stats.store();
    expect(fake.__wd.calls('storeStats')).toHaveLength(1);
  });
});

describe('leaderboards', () => {
  it('resolves a board name to its id once and submits by id, keeping the best', async () => {
    const fake = createFakeWavedash();
    const { boards } = createWavedashServices(() => asSdk(fake));
    const first = await boards.submit(NET, 420, { stars: 2, bill: 80 });
    expect(first).toEqual({ rank: 1, best: true, runRank: 1 });
    const worse = await boards.submit(NET, 300);
    expect(worse).toMatchObject({ rank: 1, best: false });
    expect(fake.__wd.calls('getOrCreateLeaderboard')).toHaveLength(1);
    expect(fake.__wd.calls('getOrCreateLeaderboard')[0].args).toEqual(['high-score', 1, 0]); // desc, numeric
    const up = fake.__wd.calls('uploadLeaderboardScore')[0].args;
    expect(up[0]).toBe('lb_high-score'); // the id, never the name
    expect(up[2]).toBe(true); // keepBest
    expect(up[4]).toEqual({ stars: 2, bill: 80 });
  });

  it('creates ascending millisecond boards with the right constants', async () => {
    const fake = createFakeWavedash();
    const { boards } = createWavedashServices(() => asSdk(fake));
    await boards.submit(FAST, 61234.6);
    expect(fake.__wd.calls('getOrCreateLeaderboard')[0].args).toEqual(['fastest-round', 0, 2]);
    expect(fake.__wd.state.boards['fastest-round'].entries[0].score).toBe(61235); // whole numbers only
  });

  it('a lookup that failed is forgotten so the next score tries again', async () => {
    const fake = createFakeWavedash();
    const real = fake.getOrCreateLeaderboard as (...a: unknown[]) => Promise<unknown>;
    let n = 0;
    fake.getOrCreateLeaderboard = async (...a: unknown[]) => (++n === 1 ? { success: false, data: null, message: 'nope' } : real(...a));
    const { boards } = createWavedashServices(() => asSdk(fake));
    expect(await boards.submit(NET, 100)).toBeNull();
    expect(await boards.submit(NET, 100)).toMatchObject({ rank: 1 });
  });

  it('clamps metadata so it can never cost a player the score', async () => {
    const fake = createFakeWavedash();
    const { boards } = createWavedashServices(() => asSdk(fake));
    const long = 'x'.repeat(500);
    const meta: Record<string, unknown> = { outfit: long, ok: 1, flag: true, nested: { a: 1 }, nothing: null, nan: NaN };
    for (let i = 0; i < 30; i++) meta[`k${i}`] = i;
    const result = await boards.submit(NET, 777, meta as never);
    expect(result).toMatchObject({ rank: 1, best: true });
    const stored = fake.__wd.state.boards['high-score'].entries[0].metadata as Record<string, unknown>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(16);
    expect(String(stored.outfit).length).toBeLessThanOrEqual(128);
    expect(stored).not.toHaveProperty('nested');
    expect(stored).not.toHaveProperty('nothing');
    expect(stored).not.toHaveProperty('nan');
  });

  it('clampMeta keeps within 2048 bytes and drops empty results', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 16; i++) big[`key_${i}`] = 'y'.repeat(200);
    const out = clampMeta(big)!;
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(2048);
    expect(clampMeta({ a: { b: 1 } })).toBeUndefined();
    expect(clampMeta(undefined)).toBeUndefined();
    expect(clampMeta({ ['k'.repeat(65)]: 1 })).toBeUndefined();
  });

  it('lists the top entries and the player neighbourhood, marking the player', async () => {
    const fake = createFakeWavedash({ userId: 'user_me', username: 'Me' });
    const { boards } = createWavedashServices(() => asSdk(fake));
    await boards.submit(NET, 500);
    const b = fake.__wd.state.boards['high-score'];
    b.entries.push({ userId: 'u_a', username: 'Ann', score: 900, ts: 1 }, { userId: 'u_b', username: 'Bo', score: 100, ts: 2 });
    const top = (await boards.top(NET, 10))!;
    expect(top.map((e) => [e.rank, e.name, e.score, e.me])).toEqual([[1, 'Ann', 900, false], [2, 'Me', 500, true], [3, 'Bo', 100, false]]);
    const near = (await boards.around(NET, 1, 1))!;
    expect(near.map((e) => e.name)).toEqual(['Ann', 'Me', 'Bo']);
    expect(near.find((e) => e.me)?.rank).toBe(2);
  });

  it('reading a board that does not exist yet creates it and reads as an empty list', async () => {
    const fake = createFakeWavedash();
    const { boards } = createWavedashServices(() => asSdk(fake));
    expect(await boards.top(NET, 10)).toEqual([]);
    expect(await boards.around(NET, 2, 2)).toBeNull();
    // (the host's own wording for a missing board is not known, so ANY failed lookup falls back to getOrCreate)
    expect(fake.__wd.calls('getOrCreateLeaderboard')).toHaveLength(1);
    expect(Object.keys(fake.__wd.state.boards)).toEqual(['high-score']);
  });

  it('a lookup that throws, or answers in any wording, still reads as an empty list; the host wording is logged', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = createFakeWavedash();
    a.getLeaderboard = async () => ({ success: false, data: null, message: 'Something else entirely' });
    expect(await createWavedashServices(() => asSdk(a)).boards.top(NET, 5)).toEqual([]);
    const b = createFakeWavedash();
    b.getLeaderboard = async () => {
      throw new Error('Leaderboard not found');
    };
    expect(await createWavedashServices(() => asSdk(b)).boards.top(NET, 5)).toEqual([]);
    expect(info.mock.calls.some((c) => String(c[0]).includes('getLeaderboard("high-score")'))).toBe(true);
  });

  it('only when the host cannot create the board either is a read an error (null)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const broken = createFakeWavedash();
    broken.getLeaderboard = async () => ({ success: false, data: null, message: 'internal error' });
    broken.getOrCreateLeaderboard = async () => ({ success: false, data: null, message: 'internal error' });
    expect(await createWavedashServices(() => asSdk(broken)).boards.top(NET, 5)).toBeNull();
  });

  it('answers null with no host or a failing host', async () => {
    const none = createWavedashServices(() => null).boards;
    expect(await none.submit(NET, 1)).toBeNull();
    expect(await none.top(NET, 5)).toBeNull();
    expect(await none.around(NET, 2, 2)).toBeNull();
    const fake = createFakeWavedash();
    fake.uploadLeaderboardScore = async () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createWavedashServices(() => asSdk(fake)).boards.submit(NET, 5)).toBeNull();
    expect(await createWavedashServices(() => asSdk(fake)).boards.submit(NET, Number.NaN)).toBeNull();
  });
});

describe('paid content', () => {
  it('reads what the player owns, and null when the host cannot say', async () => {
    const fake = createFakeWavedash({ entitled: ['style-pack'] });
    const { paid } = createWavedashServices(() => asSdk(fake));
    expect(paid.owns('style-pack')).toBe(false); // nothing is known until the first refresh
    expect([...(await paid.refresh())!]).toEqual(['style-pack']);
    expect(paid.owns('style-pack')).toBe(true);
    expect(paid.owns('other')).toBe(false);
    fake.getEntitlements = async () => ({ success: false, data: null, message: 'offline' });
    expect(await paid.refresh()).toBeNull();
    expect(paid.owns('style-pack')).toBe(true); // the last answer stands
  });

  it('opens the checkout, and reports owned when the purchase completes', async () => {
    const fake = createFakeWavedash({ paywall: 'grant' });
    const svc = createWavedashServices(() => asSdk(fake));
    svc.attach();
    expect(await svc.paid.purchase('style-pack')).toBe(true);
    expect(fake.__wd.state.paywallCalls).toEqual(['style-pack']);
    expect(svc.paid.owns('style-pack')).toBe(true);
    // already owned: no second checkout
    expect(await svc.paid.purchase('style-pack')).toBe(true);
    expect(fake.__wd.state.paywallCalls).toEqual(['style-pack']);
  });

  it('a dismissed or failed checkout owns nothing', async () => {
    for (const paywall of ['dismiss', 'error'] as const) {
      const fake = createFakeWavedash({ paywall });
      const { paid } = createWavedashServices(() => asSdk(fake));
      expect(await paid.purchase('style-pack')).toBe(false);
      expect(paid.owns('style-pack')).toBe(false);
    }
  });

  it('tells listeners about content granted from anywhere (store page, gift code), and can stop', async () => {
    const fake = createFakeWavedash();
    const svc = createWavedashServices(() => asSdk(fake));
    svc.attach();
    svc.attach(); // idempotent: one subscription
    const seen: string[][] = [];
    const off = svc.paid.onGranted((ids) => seen.push([...ids]));
    fake.__wd.grant('style-pack');
    expect(seen).toEqual([['style-pack']]);
    expect(svc.paid.owns('style-pack')).toBe(true);
    off();
    fake.__wd.grant('other-pack');
    expect(seen).toHaveLength(1);
    expect(fake.__wd.calls('on')).toHaveLength(1);
  });

  it('a throwing listener does not stop the others', () => {
    const fake = createFakeWavedash();
    const svc = createWavedashServices(() => asSdk(fake));
    svc.attach();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    svc.paid.onGranted(() => {
      throw new Error('bad listener');
    });
    svc.paid.onGranted((ids) => seen.push(...ids));
    fake.__wd.grant('style-pack');
    expect(seen).toEqual(['style-pack']);
  });

  it('is inert with no host', async () => {
    const { paid } = createWavedashServices(() => null);
    expect(await paid.refresh()).toBeNull();
    expect(await paid.purchase('style-pack')).toBe(false);
    expect(paid.owns('style-pack')).toBe(false);
  });
});

describe('the Wavedash platform', () => {
  it('offers stats and boards, connects them to the injected SDK during init(), and leaves paid content off by default', async () => {
    const fake = createFakeWavedash({ entitled: ['style-pack'], stats: ['POINTS_TOTAL'] });
    const p = createWavedashPlatform({ Wavedash: fake });
    expect(p.stats && p.boards).toBeTruthy();
    expect(p.paid).toBeUndefined(); // explicit opt-in, no inherited store
    await p.init();
    expect(await settle(p.stats!.load())).toBe(true);
    expect(p.stats!.setStat('POINTS_TOTAL', 4)).toBe(true);
    expect(fake.__wd.state.stats.POINTS_TOTAL).toBe(4);
  });

  it('exposes paid content only with the adapter option', async () => {
    const fake = createFakeWavedash({ entitled: ['style-pack'] });
    const p = createWavedashPlatform({ Wavedash: fake }, { paidContent: true });
    await p.init();
    await p.paid!.refresh();
    expect(p.paid!.owns('style-pack')).toBe(true);
  });

  it('without the SDK the services exist but are inert', async () => {
    const p = createWavedashPlatform({});
    await p.init();
    expect(p.stats!.setStat('X', 1)).toBe(false);
    expect(await p.boards!.top(NET, 5)).toBeNull();
    expect(await p.userToken!()).toBeNull();
  });

  it("userToken() answers the SDK's gameplay JWT for the game's server, and null whenever there is none", async () => {
    const fake = createFakeWavedash({ userId: 'u_1', userJwt: 'header.payload.signature' });
    const p = createWavedashPlatform({ Wavedash: fake });
    expect(await p.userToken!()).toBeNull(); // before init(): no SDK yet
    await p.init();
    expect(await p.userToken!()).toBe('header.payload.signature');
    expect(fake.__wd.calls('getUserJwt')).toHaveLength(1);
    expect(await withDefault()).toBe('fake-jwt.u_2');

    const failed = createWavedashPlatform({ Wavedash: createFakeWavedash({ userJwt: null }) });
    await failed.init();
    expect(await failed.userToken!()).toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const getUserJwt of [async () => { throw new Error('offline'); }, async () => ({ success: true, data: '' }), async () => undefined, async () => ({ success: true, data: 42 })]) {
      const odd = createWavedashPlatform({ Wavedash: { getUserJwt } });
      await odd.init();
      expect(await odd.userToken!()).toBeNull();
    }
    expect(warn).toHaveBeenCalledWith('[wavedash] getUserJwt failed', expect.any(Error));
  });
});

async function withDefault() {
  const p = createWavedashPlatform({ Wavedash: createFakeWavedash({ userId: 'u_2' }) });
  await p.init();
  return p.userToken!();
}

// ---------------------------------------------------------------------------------------
// Lobbies and P2P. One fake per player, sharing a hub; `player` boots that player's platform.

const hub = () => createFakeWavedashHub();
const player = async (h: ReturnType<typeof createFakeWavedashHub>, userId: string, opts: WavedashOptions = {}, fakeOpts: Record<string, unknown> = {}) => {
  const fake = createFakeWavedash({ userId, username: userId.toUpperCase(), ...fakeOpts }, h);
  const p = createWavedashPlatform({ Wavedash: fake }, opts);
  await p.init();
  p.ready();
  return { fake, p, lobbies: p.lobbies! };
};
const bytes = (...b: number[]) => new Uint8Array(b);

describe('lobbies', () => {
  it('create joins the lobby once: no joinLobby after createLobby, whichever arrives first, the call or LobbyJoined', async () => {
    for (const lobbyEventsFirst of [false, true]) {
      const { fake, lobbies } = await player(hub(), 'u_a', {}, { lobbyEventsFirst });
      const seen: (LobbyState | null)[] = [];
      lobbies.onUpdate((s) => seen.push(s));
      const s = await settle(lobbies.create({ maxPlayers: 4 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(s).toMatchObject({ lobbyId: 'lobby_1', hostId: 'u_a', isHost: true, users: [{ userId: 'u_a', username: 'U_A', isHost: true }] });
      expect(lobbies.current()).toMatchObject({ lobbyId: 'lobby_1', isHost: true });
      expect(seen.at(-1)).toMatchObject({ lobbyId: 'lobby_1' });
      expect(fake.__wd.calls('createLobby')).toHaveLength(1);
      expect(fake.__wd.calls('joinLobby')).toHaveLength(0);
      // Joining the lobby the player is already in answers locally: asking the host would rebuild every P2P connection.
      expect(await settle(lobbies.join('lobby_1'))).toMatchObject({ lobbyId: 'lobby_1' });
      expect(fake.__wd.calls('joinLobby')).toHaveLength(0);
      expect(fake.__wd.state.p2pRebuilds).toBe(0);
    }
  });

  it("passes the game's cap and visibility, and no cap of its own when the game gives none", async () => {
    const { fake, lobbies } = await player(hub(), 'u_a');
    await settle(lobbies.create());
    await lobbies.leave();
    await settle(lobbies.create({ maxPlayers: 3, visibility: 'private' }));
    expect(fake.__wd.calls('createLobby').map((c) => c.args)).toEqual([[0], [2, 3]]);
    expect(fake.__wd.hub.lobbies.lobby_1).toBeUndefined(); // the first was left (and, empty, closed)
    expect(fake.__wd.hub.lobbies.lobby_2.maxPlayers).toBe(3);
  });

  it("findOrCreate joins the first listed lobby with room that the game's filter accepts, else creates one", async () => {
    const h = hub();
    const host1 = await player(h, 'u_h1');
    const host2 = await player(h, 'u_h2');
    const host3 = await player(h, 'u_h3');
    await settle(host1.lobbies.create({ maxPlayers: 4 }));
    host1.lobbies.setData('mode', 'ended');
    await settle(host2.lobbies.create({ maxPlayers: 1 })); // full
    await settle(host3.lobbies.create({ maxPlayers: 4 }));
    host3.lobbies.setData('mode', 'open');

    const me = await player(h, 'u_me');
    const filter = vi.fn((l: { metadata: Record<string, unknown> }) => l.metadata.mode !== 'ended');
    const joined = await settle(me.lobbies.findOrCreate({ filter }));
    expect(joined).toMatchObject({ lobbyId: 'lobby_3', hostId: 'u_h3', isHost: false, metadata: { mode: 'open' } });
    expect(filter).toHaveBeenCalledTimes(2); // the full lobby was skipped before the filter was asked
    expect(me.fake.__wd.calls('createLobby')).toHaveLength(0);

    const other = await player(h, 'u_other');
    const made = await settle(other.lobbies.findOrCreate({ filter: () => false, maxPlayers: 2 }));
    expect(made).toMatchObject({ lobbyId: 'lobby_4', isHost: true });
    expect(other.fake.__wd.calls('createLobby').map((c) => c.args)).toEqual([[0, 2]]);
  });

  it('findOrCreate called twice at once (a double click) makes one lobby', async () => {
    const { fake, lobbies } = await player(hub(), 'u_a');
    const [a, b] = await settle(Promise.all([lobbies.findOrCreate(), lobbies.findOrCreate()]));
    expect(a?.lobbyId).toBe(b?.lobbyId);
    expect(fake.__wd.calls('createLobby')).toHaveLength(1);
  });

  it('keeps metadata known from the listing when the join resolves before its event', async () => {
    const h = hub();
    const host = await player(h, 'u_h');
    await settle(host.lobbies.create());
    host.lobbies.setData('room', 'r1');
    const guest = await player(h, 'u_g');
    const listed = await settle(guest.lobbies.list());
    expect(listed).toEqual([{ lobbyId: 'lobby_1', visibility: 'public', maxPlayers: 4, playerCount: 1, metadata: { room: 'r1' } }]);
    const joined = await guest.lobbies.join('lobby_1'); // resolved, LobbyJoined not yet delivered
    expect(joined?.metadata).toEqual({ room: 'r1' });
    expect(guest.lobbies.getData('room')).toBe('r1');
  });

  it('metadata is written by the host only, reaches the members, and null deletes a key', async () => {
    const h = hub();
    const host = await player(h, 'u_h');
    const guest = await player(h, 'u_g');
    await settle(host.lobbies.create());
    await settle(guest.lobbies.join('lobby_1'));
    const guestSaw: (LobbyState | null)[] = [];
    guest.lobbies.onUpdate((s) => guestSaw.push(s));
    expect(host.lobbies.setData('phase', 'warmup')).toBe(true);
    expect(host.lobbies.setData('slots', 3)).toBe(true);
    expect(guestSaw.at(-1)?.metadata).toEqual({ phase: 'warmup', slots: 3 });
    expect(guest.lobbies.setData('phase', 'cheat')).toBe(false); // not the host
    expect(host.lobbies.setData('bad', Number.NaN)).toBe(false); // the SDK would throw
    expect(host.lobbies.setData('phase', null)).toBe(true);
    expect(guest.lobbies.getData('phase')).toBeNull();
    expect(guest.lobbies.current()?.metadata).toEqual({ slots: 3 });
  });

  it('tracks members joining and leaving, and hosting passing on when the host leaves', async () => {
    const h = hub();
    const host = await player(h, 'u_h');
    const guest = await player(h, 'u_g');
    await settle(host.lobbies.create());
    await settle(guest.lobbies.join('lobby_1'));
    expect(host.lobbies.current()?.users.map((u) => u.userId)).toEqual(['u_h', 'u_g']);
    expect(guest.lobbies.current()).toMatchObject({ hostId: 'u_h', isHost: false });
    await host.lobbies.leave();
    expect(host.lobbies.current()).toBeNull();
    expect(guest.lobbies.current()).toMatchObject({ hostId: 'u_g', isHost: true, users: [{ userId: 'u_g', isHost: true }] });
    expect(guest.lobbies.setData('phase', 'mine')).toBe(true);
  });

  it('a kick clears the current lobby', async () => {
    const { fake, lobbies } = await player(hub(), 'u_a');
    await settle(lobbies.create());
    const seen: (LobbyState | null)[] = [];
    lobbies.onUpdate((s) => seen.push(s));
    fake.__wd.kick('lobby_1');
    expect(seen).toEqual([null]);
    expect(lobbies.current()).toBeNull();
  });

  it('chat reaches the members and refuses lines over the cap (game state belongs on P2P)', async () => {
    const h = hub();
    const host = await player(h, 'u_h');
    const guest = await player(h, 'u_g');
    expect(host.lobbies.sendMessage('hi')).toBe(false); // not in a lobby
    await settle(host.lobbies.create());
    await settle(guest.lobbies.join('lobby_1'));
    const got: string[] = [];
    guest.lobbies.onMessage((m) => got.push(`${m.userId}:${m.message}`));
    expect(host.lobbies.sendMessage('hi')).toBe(true);
    expect(host.lobbies.sendMessage('x'.repeat(LOBBY_MESSAGE_MAX))).toBe(true);
    expect(host.lobbies.sendMessage('x'.repeat(LOBBY_MESSAGE_MAX + 1))).toBe(false);
    expect(host.fake.__wd.calls('sendLobbyMessage')).toHaveLength(2); // the long one never reached the host
    expect(got).toEqual(['u_h:hi', `u_h:${'x'.repeat(LOBBY_MESSAGE_MAX)}`]);
  });

  it('invites, invite links, launch lobbies and presence', async () => {
    const h = hub();
    const host = await player(h, 'u_h');
    const friend = await player(h, 'u_f', {}, { launchParams: { lobby: 'lobby_1' } });
    expect(host.lobbies.getUser()).toEqual({ id: 'u_h', username: 'U_H' });
    expect(host.lobbies.launchLobbyId()).toBeNull();
    expect(friend.lobbies.launchLobbyId()).toBe('lobby_1');
    expect(await host.lobbies.inviteLink()).toBeNull(); // not in a lobby
    await settle(host.lobbies.create({ visibility: 'friends' }));
    expect(await settle(host.lobbies.inviteLink({ copy: true }))).toContain('lobby_1');
    expect(host.fake.__wd.calls('getLobbyInviteLink')[0].args).toEqual([true]);
    const invites: unknown[] = [];
    friend.lobbies.onInvite((i) => invites.push(i));
    expect(await settle(host.lobbies.invite('u_f'))).toBe(true);
    expect(invites).toEqual([{ lobbyId: 'lobby_1', senderId: 'u_h', senderName: 'U_H' }]);
    expect(await settle(friend.lobbies.list())).toEqual([]); // friends-only lobbies are not in the public list
    expect((await settle(friend.lobbies.list({ friendsOnly: true })))?.map((l) => l.visibility)).toEqual(['friends']);
    host.lobbies.setPresence('In a lobby', 'Quickplay');
    host.lobbies.setPresence();
    expect(host.fake.__wd.calls('updateUserPresence').map((c) => c.args[0])).toEqual([{ status: 'In a lobby', details: 'Quickplay' }, {}]);
  });

  it('answers null or false, never throws, when the host is down or absent', async () => {
    const { lobbies } = await player(hub(), 'u_a', { p2p: true }, { failLobbies: true });
    expect(await settle(lobbies.list())).toBeNull();
    expect(await settle(lobbies.create())).toBeNull();
    expect(await settle(lobbies.findOrCreate())).toBeNull();
    expect(await settle(lobbies.join('lobby_9'))).toBeNull();
    expect(lobbies.setData('k', 1)).toBe(false);
    await lobbies.leave();

    const none = createWavedashLobbies(() => null, p2pConfig(true));
    expect(await none.list()).toBeNull();
    expect(await none.create()).toBeNull();
    expect(none.getUser()).toBeNull();
    expect(none.launchLobbyId()).toBeNull();
    expect(none.p2p!.broadcast(bytes(1))).toBe(false);
    expect(none.p2p!.read()).toBeNull();
    none.setPresence('x');
  });
});

describe('P2P', () => {
  it('is off unless the game opts in: no p2p service, and init() gets no p2p block', async () => {
    const { fake, p } = await player(hub(), 'u_a');
    expect(p.lobbies!.p2p).toBeUndefined();
    expect(fake.__wd.calls('init')[0].args[0]).toEqual({ debug: false });
  });

  it("follows the game's game.json: init() gets a p2p block only when platform.wavedash.p2p opts in", async () => {
    const identity = (platform?: unknown) =>
      publicIdentity(validateGameManifest({ id: 'g', title: 'G', storagePrefix: 'g', version: '1', ...(platform ? { platform } : {}) })) as { platform: { wavedash: WavedashOptions } };
    const initArgs = async (platform?: unknown) => {
      const { fake, p } = await player(hub(), 'u_a', identity(platform).platform.wavedash);
      return { init: fake.__wd.calls('init')[0].args[0], p2p: p.lobbies!.p2p, paid: p.paid };
    };
    expect(await initArgs()).toEqual({ init: { debug: false }, p2p: undefined, paid: undefined });
    expect(await initArgs({ wavedash: { p2p: false, paidContent: false } })).toEqual({ init: { debug: false }, p2p: undefined, paid: undefined });
    const on = await initArgs({ wavedash: { p2p: true, paidContent: true } });
    expect(on.init).toEqual({ debug: false, p2p: { enableReliableChannel: true, enableUnreliableChannel: true, messageSize: 2048, maxIncomingMessages: 1024 } });
    expect(on.p2p && on.paid).toBeTruthy();
    const sized = await initArgs({ wavedash: { p2p: { messageSize: 4096, maxIncomingMessages: 128, unreliable: false } } });
    expect(sized.init).toEqual({ debug: false, p2p: { enableReliableChannel: true, enableUnreliableChannel: false, messageSize: 4096, maxIncomingMessages: 128 } });
  });

  it("passes the game's limits to init(), clamped to the SDK's, with the SDK's defaults otherwise", async () => {
    expect(p2pConfig(true)).toEqual({ enableReliableChannel: true, enableUnreliableChannel: true, messageSize: P2P_DEFAULTS.messageSize, maxIncomingMessages: P2P_DEFAULTS.maxIncomingMessages });
    expect(p2pConfig({ messageSize: 10, maxIncomingMessages: 0 })).toMatchObject({ messageSize: 45, maxIncomingMessages: 1 });
    expect(p2pConfig({ messageSize: 1e9, unreliable: false })).toMatchObject({ messageSize: 65536, enableUnreliableChannel: false });
    const { fake, p } = await player(hub(), 'u_a', { p2p: { messageSize: 8192, maxIncomingMessages: 256 } });
    expect(fake.__wd.calls('init')[0].args[0]).toEqual({ debug: false, p2p: { enableReliableChannel: true, enableUnreliableChannel: true, messageSize: 8192, maxIncomingMessages: 256 } });
    expect(p.lobbies!.p2p!.maxPayloadBytes()).toBe(8192 - 44);
  });

  it('sends binary messages between distinct members, per channel, and reports peers coming and going', async () => {
    const h = hub();
    const host = await player(h, 'u_h', { p2p: { messageSize: 64 } });
    const guest = await player(h, 'u_g', { p2p: { messageSize: 64 } });
    const hostPeers: P2PPeerEvent[] = [];
    host.lobbies.p2p!.onPeer((e) => hostPeers.push(e));
    await settle(host.lobbies.create());
    expect(host.lobbies.p2p!.broadcast(bytes(1))).toBe(false); // nobody to send to yet
    await settle(guest.lobbies.join('lobby_1'));
    expect(hostPeers).toEqual([{ userId: 'u_g', username: 'U_G', state: 'connected' }]);

    expect(host.lobbies.p2p!.broadcast(bytes(1, 2, 3), { channel: 1, reliable: false })).toBe(true);
    expect(guest.lobbies.p2p!.send('u_h', bytes(9))).toBe(true);
    expect(guest.lobbies.p2p!.read(0)).toBeNull(); // channel 1 only
    expect(guest.lobbies.p2p!.read(1)).toEqual({ fromUserId: 'u_h', channel: 1, payload: bytes(1, 2, 3) });
    expect(guest.lobbies.p2p!.read(1)).toBeNull();
    expect(host.lobbies.p2p!.read()).toEqual({ fromUserId: 'u_g', channel: 0, payload: bytes(9) });

    expect(host.lobbies.p2p!.broadcast(new Uint8Array(64 - 44))).toBe(true);
    expect(host.lobbies.p2p!.broadcast(new Uint8Array(64 - 43))).toBe(false); // over the slot
    expect(host.lobbies.p2p!.broadcast(bytes(1), { channel: 8 })).toBe(false);
    expect(host.lobbies.p2p!.send('u_nobody', bytes(1))).toBe(false);
    expect(host.fake.__wd.calls('broadcastP2PMessage')).toHaveLength(3); // the invalid ones never reached the host

    await guest.lobbies.leave();
    expect(hostPeers.at(-1)).toEqual({ userId: 'u_g', state: 'disconnected' });
  });

  it("drops what a channel's queue cannot hold until it is read", async () => {
    const h = hub();
    const host = await player(h, 'u_h', { p2p: true });
    const guest = await player(h, 'u_g', { p2p: { maxIncomingMessages: 2 } });
    await settle(host.lobbies.create());
    await settle(guest.lobbies.join('lobby_1'));
    for (let i = 0; i < 3; i++) host.lobbies.p2p!.broadcast(bytes(i));
    expect([guest.lobbies.p2p!.read(), guest.lobbies.p2p!.read(), guest.lobbies.p2p!.read()].map((m) => m?.payload[0] ?? null)).toEqual([0, 1, null]);
    expect(guest.fake.__wd.state.dropped).toBe(1);
  });

  it('two tabs with one user id are one member and never peers', async () => {
    const h = hub();
    const tab1 = await player(h, 'u_same', { p2p: true });
    const tab2 = await player(h, 'u_same', { p2p: true });
    await settle(tab1.lobbies.create());
    const joined = await settle(tab2.lobbies.join('lobby_1'));
    expect(joined?.users.map((u) => u.userId)).toEqual(['u_same']);
    expect(tab1.lobbies.p2p!.broadcast(bytes(1))).toBe(false);
    expect(tab2.lobbies.p2p!.read()).toBeNull();
  });
});
