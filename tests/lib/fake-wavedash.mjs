// A stand-in for the `window.Wavedash` object the platform injects, for tests that must not touch the network: the adapter's unit tests
// (import `createFakeWavedash`), and real-browser checks (`fakeWavedashSource(options)` is a script for
// Page.addScriptToEvaluateOnNewDocument, so the game boots as if hosted; `window.__wd` then shows what it did).
//
// It reproduces the behaviour that cost the sibling game time, from docs.wavedash.com and @wvdsh/sdk-js 1.3.53:
//  - setStat / setAchievement return false and DROP the write until requestStats() has resolved, and for ids the project does not define;
//  - every leaderboard call except get/getOrCreate takes the board's ID, not its name;
//  - leaderboard metadata over 16 keys / 256-char strings / 2048 bytes rejects the whole score;
//  - async calls answer { success, data } or { success: false, data: null, message };
//  - locked files answer 403 until owned, and EntitlementsGranted fires for every grant, whoever started it;
//  - lobbies (docs.wavedash.com/multiplayer/lobbies): creating one joins it; joinLobby on a lobby the player is in fires LobbyJoined again and
//    rebuilds every P2P connection (counted in state.p2pRebuilds); only the host writes lobby data, and LobbyDataUpdated carries the whole map;
//    chat lines over 500 characters are refused; the host passes to the next member when the host leaves;
//  - P2P (/multiplayer/networking): a mesh between the members with distinct user ids, connected when a player joins; channels 0..7; a send
//    answers false when nothing was sent; each channel queues up to maxIncomingMessages (init's p2p block) and drops the rest;
//  - members are keyed on the user id, so two fakes with the same userId (two tabs in one browser) are one member and never peers.
//
// Several fakes share lobbies when created with the same hub (`createFakeWavedashHub()`), one fake per player; without one, a fake has its own.
//
// The options are plain data so the whole factory can be serialised into a page (it must not close over anything):
//   statsDelayMs   ms before requestStats resolves (default 0)
//   stats          stat ids the project defines; achievements  achievement ids it defines (default: any id is accepted when the list is omitted)
//   entitled       content identifiers the player already owns
//   paywall        "grant" (the checkout completes) | "dismiss" (the player closes it) | "error" (the call fails)
//   username, userId
//   userJwt        what getUserJwt() answers: a string (default "fake-jwt.<userId>", NOT a real signed token), or null for a failed call
//   failStats      requestStats answers success:false
//   remoteFiles    { path: text } already in the player's cloud storage (a save from an earlier build, for update tests)
//   failDownload   cloud reads fail and the existence check fails too (the host is unreachable)
//   launchParams   what getLaunchParams() answers (an invite link opens the game with { lobby: id })
//   defaultMaxPlayers  the cap createLobby uses when the game gives none (the real default is undocumented; default 4, as in the docs' examples)
//   failLobbies    every lobby call answers success:false (the host is unreachable)
//   lobbyEventsFirst  LobbyJoined (and the P2P connections) fire before createLobby/joinLobby resolve, instead of just after

/** Lobbies shared by every fake created with it: one hub per test, one fake per player. */
export function createFakeWavedashHub() {
  return { lobbies: {}, clients: [], next: 1 };
}

export function createFakeWavedash(options = {}, sharedHub = null) {
  const opts = { statsDelayMs: 0, paywall: "grant", username: "Tester", userId: "user_me", entitled: [], launchParams: {}, defaultMaxPlayers: 4, ...options };
  const hub = sharedHub ?? { lobbies: {}, clients: [], next: 1 };
  const definedStats = opts.stats ? new Set(opts.stats) : null;
  const definedAchievements = opts.achievements ? new Set(opts.achievements) : null;
  const log = [];
  const state = {
    statsLoaded: false,
    stats: {},
    achievements: {},
    boards: {}, // name -> { id, sort, display, entries: [{ userId, username, score, metadata, ts }] }
    entitlements: new Set(opts.entitled),
    initCalls: 0,
    loadComplete: false,
    progress: 0,
    files: new Map(),
    paywallCalls: [],
    p2pConfig: null, // init's p2p block, as given
    p2pRebuilds: 0,
    presence: null,
    inbox: new Map(), // channel -> [{ fromUserId, channel, payload }]
    dropped: 0,
  };
  for (const [path, text] of Object.entries(opts.remoteFiles ?? {})) state.files.set(`remote:${path}`, new TextEncoder().encode(text));
  const listeners = new Map();
  const emit = (event, payload) => (listeners.get(event) ?? []).slice().forEach((fn) => fn(payload));
  const ok = (data) => ({ success: true, data });
  const bad = (message) => ({ success: false, data: null, message });
  const rec = (name, ...args) => log.push({ name, args, at: Date.now() });
  const later = (ms, fn) => new Promise((r) => setTimeout(() => r(fn()), ms));

  const boardById = (id) => Object.values(state.boards).find((b) => b.id === id);
  const rankOf = (b, entry) => {
    const sorted = [...b.entries].sort((x, y) => (b.sort === 0 ? x.score - y.score : y.score - x.score));
    return sorted.indexOf(entry) + 1;
  };
  const view = (b, entry) => ({ userId: entry.userId, username: entry.username, score: entry.score, globalRank: rankOf(b, entry), timestamp: entry.ts, ...(entry.metadata ? { metadata: entry.metadata } : {}) });
  const metaError = (m) => {
    if (m === undefined || m === null) return null;
    const keys = Object.keys(m);
    if (keys.length > 16) return "metadata has more than 16 keys";
    for (const k of keys) {
      if (k.length > 64) return `metadata key ${k} is longer than 64 characters`;
      const v = m[k];
      if (typeof v === "string" && v.length > 256) return `metadata value for ${k} is longer than 256 characters`;
      if (!["string", "number", "boolean"].includes(typeof v)) return `metadata value for ${k} is not a string, number or boolean`;
    }
    return JSON.stringify(m).length > 2048 ? "metadata is larger than 2048 bytes" : null;
  };

  // ---- lobbies and P2P, over the hub
  const me = { userId: opts.userId, username: opts.username, emit: (e, p) => emit(e, p), state };
  hub.clients.push(me);
  const lobbyOf = (id) => hub.lobbies[id];
  /** The fakes in a lobby: every client whose user id is a member (two tabs with one id both hear it). */
  const clientsIn = (l) => hub.clients.filter((c) => l.users.some((u) => u.userId === c.userId));
  const myLobby = () => Object.values(hub.lobbies).find((l) => l.users.some((u) => u.userId === opts.userId)) ?? null;
  const userView = (l, u) => ({ lobbyId: l.lobbyId, userId: u.userId, username: u.username, isHost: u.userId === l.hostId });
  const joinedPayload = (l) => ({ lobbyId: l.lobbyId, hostId: l.hostId, users: l.users.map((u) => userView(l, u)), metadata: { ...l.metadata } });
  const summaryOf = (l) => ({ lobbyId: l.lobbyId, visibility: l.visibility, maxPlayers: l.maxPlayers, playerCount: l.users.length, metadata: { ...l.metadata } });
  const p2pOf = (c) => ({ messageSize: 2048, maxIncomingMessages: 1024, enableReliableChannel: true, enableUnreliableChannel: true, ...(c.state.p2pConfig ?? {}) });
  const peersOf = (l) => hub.clients.filter((c) => c.userId !== opts.userId && l.users.some((u) => u.userId === c.userId));
  const deliver = (to, channel, payload) => {
    const box = to.state.inbox.get(channel) ?? [];
    if (box.length >= p2pOf(to).maxIncomingMessages) { to.state.dropped++; return; }
    box.push({ fromUserId: opts.userId, channel, payload: payload.slice() });
    to.state.inbox.set(channel, box);
  };
  const soon = (fn) => (opts.lobbyEventsFirst ? fn() : setTimeout(fn, 0));
  const p2pSend = (targets, channel, reliable, payload) => {
    const cfg = p2pOf(me);
    if (!Number.isInteger(channel) || channel < 0 || channel > 7 || !(payload instanceof Uint8Array)) return false;
    if (payload.byteLength > cfg.messageSize - 44) return false;
    if (reliable ? !cfg.enableReliableChannel : !cfg.enableUnreliableChannel) return false;
    if (!targets.length) return false;
    targets.forEach((t) => deliver(t, channel, payload));
    return true;
  };

  const sdk = {
    Events: {
      STATS_STORED: "StatsStored", BACKEND_CONNECTED: "BackendConnected", ENTITLEMENTS_GRANTED: "EntitlementsGranted", FULLSCREEN_CHANGED: "FullscreenChanged", MUTE_CHANGED: "MuteChanged",
      LOBBY_JOINED: "LobbyJoined", LOBBY_USERS_UPDATED: "LobbyUsersUpdated", LOBBY_MESSAGE: "LobbyMessage", LOBBY_DATA_UPDATED: "LobbyDataUpdated", LOBBY_KICKED: "LobbyKicked", LOBBY_INVITE: "LobbyInvite",
      P2P_CONNECTION_ESTABLISHED: "P2PConnectionEstablished", P2P_PEER_RECONNECTING: "P2PPeerReconnecting", P2P_PEER_RECONNECTED: "P2PPeerReconnected", P2P_PEER_DISCONNECTED: "P2PPeerDisconnected",
    },
    LobbyVisibility: { PUBLIC: 0, FRIENDS_ONLY: 1, PRIVATE: 2 },
    LeaderboardSortOrder: { ASC: 0, DESC: 1 },
    LeaderboardDisplayType: { NUMERIC: 0, TIME_SECONDS: 1, TIME_MILLISECONDS: 2, TIME_GAME_TICKS: 3 },
    // lifecycle
    init(config) { rec("init", config); state.initCalls++; state.loadComplete = true; if (state.initCalls === 1 && config?.p2p) state.p2pConfig = { ...config.p2p }; return state.initCalls === 1; },
    loadComplete() { rec("loadComplete"); state.loadComplete = true; },
    updateLoadProgressZeroToOne(p) { state.progress = p; },
    readyForEvents() { rec("readyForEvents"); },
    on(event, fn) { rec("on", event); listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => sdk.off(event, fn); },
    off(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn)); },
    getUser() { return { id: opts.userId, username: opts.username }; },
    getUserId() { return opts.userId; },
    // Real Wavedash answers { success, data: "<RS256 JWT>" }; this fake's token is a placeholder no server can verify.
    async getUserJwt() { rec("getUserJwt"); return opts.userJwt === null ? bad("could not get a token") : ok(opts.userJwt ?? `fake-jwt.${opts.userId}`); },
    getUsername() { return opts.username; },
    getLaunchParams() { return { ...opts.launchParams }; },
    async updateUserPresence(data) { rec("updateUserPresence", data); state.presence = { ...data }; return ok(true); },
    // lobbies
    async createLobby(...args) {
      rec("createLobby", ...args); // as called: a missing cap is logged as missing
      const [visibility, maxPlayers] = args;
      if (opts.failLobbies) return bad("lobbies unavailable");
      const lobbyId = `lobby_${hub.next++}`;
      const l = { lobbyId, visibility: visibility ?? 0, maxPlayers: maxPlayers ?? opts.defaultMaxPlayers, hostId: opts.userId, users: [{ userId: opts.userId, username: opts.username }], metadata: {} };
      hub.lobbies[lobbyId] = l;
      soon(() => clientsIn(l).forEach((c) => c.emit("LobbyJoined", joinedPayload(l))));
      return ok(lobbyId);
    },
    async joinLobby(lobbyId) {
      rec("joinLobby", lobbyId);
      if (opts.failLobbies) return bad("lobbies unavailable");
      const l = lobbyOf(lobbyId);
      if (!l) return bad("lobby not found");
      const already = l.users.some((u) => u.userId === opts.userId);
      if (!already && l.users.length >= l.maxPlayers) return bad("lobby is full");
      if (already) {
        // Joining a lobby the player is already in: LobbyJoined again, and every P2P connection is rebuilt.
        state.p2pRebuilds++;
        soon(() => me.emit("LobbyJoined", joinedPayload(l)));
        return ok(true);
      }
      l.users.push({ userId: opts.userId, username: opts.username });
      soon(() => {
        me.emit("LobbyJoined", joinedPayload(l));
        for (const c of clientsIn(l)) {
          if (c.userId === opts.userId) continue;
          c.emit("LobbyUsersUpdated", { lobbyId, userId: opts.userId, username: opts.username, isHost: false, changeType: "JOINED" });
          c.emit("P2PConnectionEstablished", { userId: opts.userId, username: opts.username });
          me.emit("P2PConnectionEstablished", { userId: c.userId, username: c.username });
        }
      });
      return ok(true);
    },
    async leaveLobby(lobbyId) {
      rec("leaveLobby", lobbyId);
      const l = lobbyOf(lobbyId);
      if (!l || !l.users.some((u) => u.userId === opts.userId)) return bad("not in that lobby");
      const others = clientsIn(l).filter((c) => c.userId !== opts.userId);
      const wasHost = l.hostId === opts.userId;
      l.users = l.users.filter((u) => u.userId !== opts.userId);
      if (!l.users.length) delete hub.lobbies[lobbyId];
      else if (wasHost) l.hostId = l.users[0].userId;
      for (const c of others) {
        c.emit("LobbyUsersUpdated", { lobbyId, userId: opts.userId, username: opts.username, isHost: wasHost, changeType: "LEFT" });
        c.emit("P2PPeerDisconnected", { userId: opts.userId });
      }
      return ok(lobbyId);
    },
    async listAvailableLobbies(friendsOnly) {
      rec("listAvailableLobbies", friendsOnly);
      if (opts.failLobbies) return bad("lobbies unavailable");
      return ok(Object.values(hub.lobbies).filter((l) => l.visibility === (friendsOnly ? 1 : 0)).map(summaryOf));
    },
    async getLobby(lobbyId) {
      rec("getLobby", lobbyId);
      const l = lobbyOf(lobbyId);
      return l ? ok(summaryOf(l)) : bad("lobby not found");
    },
    getLobbyUsers(lobbyId) { const l = lobbyOf(lobbyId); return l ? l.users.map((u) => userView(l, u)) : []; },
    getLobbyHostId(lobbyId) { return lobbyOf(lobbyId)?.hostId ?? null; },
    getNumLobbyUsers(lobbyId) { return lobbyOf(lobbyId)?.users.length ?? 0; },
    sendLobbyMessage(lobbyId, message) {
      rec("sendLobbyMessage", lobbyId, message);
      const l = lobbyOf(lobbyId);
      if (!l || !l.users.some((u) => u.userId === opts.userId) || typeof message !== "string" || message.length > 500) return false;
      const payload = { messageId: `msg_${Date.now()}`, lobbyId, userId: opts.userId, username: opts.username, message, timestamp: Date.now() };
      clientsIn(l).forEach((c) => c.emit("LobbyMessage", payload));
      return true;
    },
    setLobbyData(lobbyId, key, value) {
      rec("setLobbyData", lobbyId, key, value);
      const l = lobbyOf(lobbyId);
      if (!l || l.hostId !== opts.userId) return false;
      if (value !== null && !["string", "boolean"].includes(typeof value) && !(typeof value === "number" && Number.isFinite(value))) throw new TypeError("unsupported lobby data value");
      if (value === null) delete l.metadata[key];
      else l.metadata[key] = value;
      clientsIn(l).forEach((c) => c.emit("LobbyDataUpdated", { ...l.metadata }));
      return true;
    },
    getLobbyData(lobbyId, key) {
      const l = lobbyOf(lobbyId);
      return l && key in l.metadata ? l.metadata[key] : null;
    },
    deleteLobbyData(lobbyId, key) { rec("deleteLobbyData", lobbyId, key); return sdk.setLobbyData(lobbyId, key, null); },
    async inviteUserToLobby(lobbyId, userId) {
      rec("inviteUserToLobby", lobbyId, userId);
      const l = lobbyOf(lobbyId);
      if (!l || !l.users.some((u) => u.userId === opts.userId)) return bad("not in that lobby");
      hub.clients.filter((c) => c.userId === userId).forEach((c) => c.emit("LobbyInvite", { notificationId: `n_${Date.now()}`, lobbyId, sender: { _id: opts.userId, username: opts.username } }));
      return ok(true);
    },
    async getLobbyInviteLink(copyToClipboard) {
      rec("getLobbyInviteLink", copyToClipboard);
      const l = myLobby();
      return l ? ok(`https://wavedash.example/play?lobby=${l.lobbyId}`) : bad("not in a lobby");
    },
    // P2P
    broadcastP2PMessage(channel, reliable, payload) {
      rec("broadcastP2PMessage", channel, reliable, payload?.byteLength);
      const l = myLobby();
      return p2pSend(l ? peersOf(l) : [], channel, reliable, payload);
    },
    sendP2PMessage(userId, channel, reliable, payload) {
      rec("sendP2PMessage", userId, channel, reliable, payload?.byteLength);
      const l = myLobby();
      const peers = l ? peersOf(l) : [];
      return p2pSend(userId === undefined ? peers : peers.filter((c) => c.userId === userId), channel, reliable, payload);
    },
    readP2PMessageFromChannel(channel) { return state.inbox.get(channel)?.shift() ?? null; },
    getP2PMaxPayloadSize() { return p2pOf(me).messageSize - 44; },
    getP2PMaxIncomingMessages() { return p2pOf(me).maxIncomingMessages; },
    // stats and achievements
    requestStats() {
      rec("requestStats");
      return later(opts.statsDelayMs, () => {
        if (opts.failStats) return bad("stats unavailable");
        state.statsLoaded = true;
        return ok(true);
      });
    },
    getStat(id) { return state.statsLoaded ? state.stats[id] ?? 0 : 0; },
    setStat(id, value, storeNow) {
      rec("setStat", id, value, storeNow);
      if (!state.statsLoaded || (definedStats && !definedStats.has(id))) return false;
      state.stats[id] = value;
      return true;
    },
    getAchievement(id) { return !!state.achievements[id]; },
    setAchievement(id, storeNow) {
      rec("setAchievement", id, storeNow);
      if (!state.statsLoaded || (definedAchievements && !definedAchievements.has(id))) return false;
      state.achievements[id] = true;
      return true;
    },
    storeStats() { rec("storeStats"); return state.statsLoaded; },
    // leaderboards
    async getLeaderboard(name) {
      rec("getLeaderboard", name);
      const b = state.boards[name];
      return b ? ok({ id: b.id, name, totalEntries: b.entries.length }) : bad("leaderboard not found");
    },
    async getOrCreateLeaderboard(name, sort, display) {
      rec("getOrCreateLeaderboard", name, sort, display);
      const created = !state.boards[name];
      state.boards[name] ??= { id: `lb_${name}`, sort, display, entries: [] };
      return ok({ id: state.boards[name].id, name, totalEntries: state.boards[name].entries.length, created });
    },
    async uploadLeaderboardScore(id, score, keepBest, ugcId, metadata) {
      rec("uploadLeaderboardScore", id, score, keepBest, ugcId, metadata);
      const b = boardById(id);
      if (!b) return bad("unknown leaderboard id (did you pass the name instead of the id?)");
      const why = metaError(metadata);
      if (why) return bad(why);
      let mine = b.entries.find((e) => e.userId === opts.userId);
      const better = (s) => (b.sort === 0 ? s < mine.score : s > mine.score);
      const submittedRank = 1 + b.entries.filter((e) => e.userId !== opts.userId && (b.sort === 0 ? e.score < score : e.score > score)).length;
      let scoreChanged = true;
      if (!mine) { mine = { userId: opts.userId, username: opts.username, score, metadata, ts: Date.now() }; b.entries.push(mine); }
      else if (!keepBest || better(score)) { mine.score = score; mine.metadata = metadata; mine.ts = Date.now(); }
      else scoreChanged = false;
      return ok({ ...view(b, mine), scoreChanged, submittedScore: score, submittedRank, entryId: "entry_me" });
    },
    async listLeaderboardEntries(id, offset, limit) {
      rec("listLeaderboardEntries", id, offset, limit);
      const b = boardById(id);
      if (!b) return bad("unknown leaderboard id");
      const sorted = [...b.entries].sort((x, y) => (b.sort === 0 ? x.score - y.score : y.score - x.score));
      return ok(sorted.slice(offset, offset + limit).map((e) => view(b, e)));
    },
    async listLeaderboardEntriesAroundUser(id, ahead, behind) {
      rec("listLeaderboardEntriesAroundUser", id, ahead, behind);
      const b = boardById(id);
      if (!b) return bad("unknown leaderboard id");
      const sorted = [...b.entries].sort((x, y) => (b.sort === 0 ? x.score - y.score : y.score - x.score));
      const at = sorted.findIndex((e) => e.userId === opts.userId);
      if (at < 0) return ok([]);
      return ok(sorted.slice(Math.max(0, at - ahead), at + behind + 1).map((e) => view(b, e)));
    },
    async getMyLeaderboardEntries(id) {
      rec("getMyLeaderboardEntries", id);
      const b = boardById(id);
      if (!b) return bad("unknown leaderboard id");
      return ok(b.entries.filter((e) => e.userId === opts.userId).map((e) => view(b, e)));
    },
    getLeaderboardEntryCount(id) { return boardById(id)?.entries.length ?? -1; },
    // paid content
    async isEntitled(id) { rec("isEntitled", id); return ok(state.entitlements.has(id)); },
    async getEntitlements() { rec("getEntitlements"); return ok([...state.entitlements]); },
    async triggerPaywall(id) {
      rec("triggerPaywall", id);
      state.paywallCalls.push(id);
      if (state.entitlements.has(id)) return ok(true);
      if (opts.paywall === "error") return bad("checkout unavailable");
      if (opts.paywall === "dismiss") return ok(false);
      state.entitlements.add(id);
      setTimeout(() => emit("EntitlementsGranted", { contentIdentifiers: [id] }), 0);
      return ok(true);
    },
    isPaywallOpen() { return false; },
    // cloud saves (in memory)
    async writeLocalFile(path, data) { state.files.set(`local:${path}`, data); return true; },
    async readLocalFile(path) { return state.files.get(`local:${path}`) ?? state.files.get(`local:/${path}`) ?? null; },
    async uploadRemoteFile(path) { rec("uploadRemoteFile", path); const d = state.files.get(`local:${path}`); if (!d) return bad("no such local file"); state.files.set(`remote:${path}`, d); return ok(path); },
    async downloadRemoteFile(path) { rec("downloadRemoteFile", path); if (opts.failDownload) return bad("host unreachable"); const d = state.files.get(`remote:${path}`); if (!d) return bad("no such remote file"); state.files.set(`local:${path}`, d); return ok(path); },
    async remoteFileExists(path) { if (opts.failDownload) return bad("host unreachable"); return ok(state.files.has(`remote:${path}`)); },
  };
  // What a test can poke at: grant content from "the store page", read the call log and the state.
  sdk.__wd = {
    log,
    state,
    grant(...ids) { ids.forEach((i) => state.entitlements.add(i)); emit("EntitlementsGranted", { contentIdentifiers: ids }); },
    revoke(...ids) { ids.forEach((i) => state.entitlements.delete(i)); },
    calls: (name) => log.filter((c) => c.name === name),
    hub,
    /** Remove the player from a lobby as the host would (LobbyKicked). */
    kick(lobbyId, reason = "kicked") {
      const l = lobbyOf(lobbyId);
      if (!l) return;
      l.users = l.users.filter((u) => u.userId !== opts.userId);
      emit("LobbyKicked", { reason });
    },
    /** The player's cloud files as text, {path: text}. */
    dumpRemote() {
      const out = {};
      for (const [k, v] of state.files) if (k.startsWith("remote:")) out[k.slice(7)] = new TextDecoder().decode(v);
      return out;
    },
  };
  return sdk;
}

/** A script that installs the fake as `window.Wavedash` (and `window.__wd`) before the page's own scripts run. */
export function fakeWavedashSource(options = {}) {
  return `(() => { const make = ${createFakeWavedash.toString()}; const sdk = make(${JSON.stringify(options)}); window.Wavedash = sdk; window.__wd = sdk.__wd; })();`;
}
