// Wavedash Lobbies and P2P behind the LobbyService interface (types.ts): the host's matchmaking layer, not a game server. Built on the shapes in
// wavedash-sdk.ts and tested against tests/lib/fake-wavedash.mjs. What the adapter accounts for (docs.wavedash.com/multiplayer/lobbies and
// /networking, and a game that shipped on it):
//  - creating a lobby joins it; calling joinLobby on it again fires LOBBY_JOINED a second time and rebuilds every P2P connection, so create()
//    never joins and join() of the current lobby answers without asking the host;
//  - LOBBY_JOINED can arrive before or after create/join resolves, so the state is built from whichever comes first and the event wins;
//  - a join can resolve before the lobby's metadata arrives, so metadata already known (the listing, getLobby) is kept, not cleared;
//  - only the host may write lobby data; LOBBY_DATA_UPDATED carries the whole map;
//  - chat lines are capped at 500 characters: chat is for people, game state goes over P2P;
//  - the P2P mesh is built by the host when players join; sends answer false when nothing was sent, and incoming messages queue per channel
//    (up to the configured limit) until read;
//  - the host keys members and peers on the account: two tabs in one browser share one getUserId(), so they are one member and never peers.
// Event payloads are given by example, not schema, in the docs, so every handler reads them defensively.
import type {
  LobbyChatMessage,
  LobbyInvite,
  LobbyMember,
  LobbyService,
  LobbyState,
  LobbySummary,
  LobbyValue,
  LobbyVisibility,
  P2PMessage,
  P2PPeerEvent,
  P2PService,
} from "./types";
import type { WavedashLobby, WavedashLobbyUser, WavedashP2PConfig, WavedashSdk } from "./wavedash-sdk";

/** The host's cap on one lobby chat line. */
export const LOBBY_MESSAGE_MAX = 500;
/** P2P channels are 0..P2P_CHANNELS-1. */
export const P2P_CHANNELS = 8;

/** A game's P2P settings (the adapter's `p2p` option). Anything left out takes the SDK's documented default. */
export interface WavedashP2POptions {
  /** Bytes per message slot, header included (45..65536; default 2048). Size it to the largest message the game sends. */
  messageSize?: number;
  /** Messages each channel queues until read (default 1024); more are dropped. */
  maxIncomingMessages?: number;
  /** Allocate the reliable (ordered, delivered) channel kind. Default true. */
  reliable?: boolean;
  /** Allocate the unreliable (best-effort) channel kind. Default true. */
  unreliable?: boolean;
}

/** The SDK's documented defaults, which a game's options override. */
export const P2P_DEFAULTS = { messageSize: 2048, maxIncomingMessages: 1024, reliable: true, unreliable: true } as const;
const MESSAGE_SIZE_MIN = 45;
const MESSAGE_SIZE_MAX = 65536;
/**
 * Per-message overhead inside a slot: a queued record is a 4-byte size, a 32-byte sender id, a 4-byte channel and a 4-byte length, which is also
 * why the SDK requires messageSize > 44. Used only when the SDK has no getP2PMaxPayloadSize.
 */
const P2P_RECORD_HEADER = 44;

/** The `init({ p2p })` block for a game's options, clamped to the SDK's limits. */
export function p2pConfig(options: true | WavedashP2POptions): Required<WavedashP2PConfig> {
  const o = options === true ? {} : options;
  const int = (v: unknown, fallback: number, min: number, max: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(Number(v)))) : fallback;
  return {
    enableReliableChannel: o.reliable ?? P2P_DEFAULTS.reliable,
    enableUnreliableChannel: o.unreliable ?? P2P_DEFAULTS.unreliable,
    messageSize: int(o.messageSize, P2P_DEFAULTS.messageSize, MESSAGE_SIZE_MIN, MESSAGE_SIZE_MAX),
    maxIncomingMessages: int(o.maxIncomingMessages, P2P_DEFAULTS.maxIncomingMessages, 1, 1 << 20),
  };
}

type Meta = Record<string, LobbyValue>;
const VISIBILITY: Record<LobbyVisibility, number> = { public: 0, friends: 1, private: 2 };
const isValue = (v: unknown): v is LobbyValue =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const cleanMeta = (m: unknown): Meta => {
  const out: Meta = {};
  if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) if (isValue(v)) out[k] = v;
  return out;
};
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const copy = (s: LobbyState | null): LobbyState | null =>
  s && { ...s, users: s.users.map((u) => ({ ...u })), metadata: { ...s.metadata } };
const emit = <T>(listeners: Set<(v: T) => void>, value: T, what: string) =>
  listeners.forEach((fn) => {
    try { fn(value); } catch (e) { console.warn(`[wavedash] a ${what} listener failed`, e); }
  });

/**
 * `getSdk` is read at use time (the SDK arrives during the platform's `init()`). `p2p` is the config the adapter passes to the SDK's `init()`, or
 * null when the game did not opt in (then `p2p` is undefined on the service).
 */
export function createWavedashLobbies(getSdk: () => WavedashSdk | null, p2p: Required<WavedashP2PConfig> | null = null): LobbyService {
  let lobby: LobbyState | null = null;
  let attached: WavedashSdk | null = null;
  let finding: Promise<LobbyState | null> | null = null;
  const updates = new Set<(state: LobbyState | null) => void>();
  const messages = new Set<(message: LobbyChatMessage) => void>();
  const invites = new Set<(invite: LobbyInvite) => void>();
  const peers = new Set<(event: P2PPeerEvent) => void>();

  const myId = () => {
    try { return str(getSdk()?.getUser?.()?.id || getSdk()?.getUserId?.()) || null; } catch { return null; }
  };
  const notify = () => emit(updates, copy(lobby), "lobby update");
  const member = (u: WavedashLobbyUser, hostId: string): LobbyMember => ({
    userId: str(u.userId),
    username: str(u.username) || "Player",
    ...(u.userAvatarUrl ? { avatarUrl: String(u.userAvatarUrl) } : {}),
    isHost: u.isHost ?? (!!hostId && str(u.userId) === hostId),
  });
  const visibilityOf = (n: unknown): LobbyVisibility => (n === 1 ? "friends" : n === 2 ? "private" : "public");
  const summary = (l: WavedashLobby): LobbySummary => {
    const max = Number(l.maxPlayers);
    return {
      lobbyId: str(l.lobbyId),
      visibility: visibilityOf(Number(l.visibility)),
      ...(Number.isFinite(max) && max > 0 ? { maxPlayers: max } : {}),
      playerCount: Number(l.playerCount) || 0,
      metadata: cleanMeta(l.metadata),
    };
  };
  const users = (sdk: WavedashSdk, lobbyId: string): WavedashLobbyUser[] | null => {
    try {
      const list = sdk.getLobbyUsers?.(lobbyId);
      return Array.isArray(list) && list.length ? list : null;
    } catch {
      return null;
    }
  };
  const hostOf = (sdk: WavedashSdk, lobbyId: string): string | null => {
    try { return str(sdk.getLobbyHostId?.(lobbyId)) || null; } catch { return null; }
  };
  /** Recompute isHost flags after the host id or member list changed. */
  const settleHost = (s: LobbyState) => {
    const me = myId();
    s.isHost = !!me && !!s.hostId && s.hostId === me;
    s.users = s.users.map((u) => ({ ...u, isHost: !!s.hostId && u.userId === s.hostId }));
  };

  /** The state after create/join resolved before LOBBY_JOINED: built from what the SDK can say now, keeping metadata already known. */
  const settle = (lobbyId: string, created: boolean, known: Meta = {}): LobbyState => {
    if (lobby?.lobbyId === lobbyId) {
      if (!Object.keys(lobby.metadata).length && Object.keys(known).length) {
        lobby.metadata = { ...known };
        notify();
      }
      return copy(lobby)!;
    }
    const sdk = getSdk()!;
    const me = myId();
    const hostId = hostOf(sdk, lobbyId) ?? (created && me ? me : "");
    const listed = users(sdk, lobbyId);
    let name = "Player";
    try { name = str(sdk.getUser?.()?.username || sdk.getUsername?.()) || name; } catch { /* keep the default */ }
    lobby = {
      lobbyId,
      hostId,
      isHost: false,
      users: listed ? listed.map((u) => member(u, hostId)) : me ? [{ userId: me, username: name, isHost: false }] : [],
      metadata: { ...known },
    };
    settleHost(lobby);
    notify();
    return copy(lobby)!;
  };

  const attach = () => {
    const sdk = getSdk();
    if (!sdk?.on || attached === sdk) return;
    attached = sdk;
    const ev = sdk.Events ?? {};
    const on = <T>(name: string | undefined, fallback: string, fn: (payload: T | undefined) => void) => {
      try {
        sdk.on!<T | undefined>(name ?? fallback, (payload) => {
          try { fn(payload); } catch (e) { console.warn(`[wavedash] handling ${fallback} failed`, e); }
        });
      } catch (e) {
        console.warn(`[wavedash] could not listen for ${fallback}`, e);
      }
    };
    type Joined = { lobbyId?: string; hostId?: string; users?: WavedashLobbyUser[]; metadata?: unknown };
    on<Joined>(ev.LOBBY_JOINED, "LobbyJoined", (p) => {
      if (!p?.lobbyId) return;
      const lobbyId = str(p.lobbyId);
      const hostId = str(p.hostId);
      const known = lobby?.lobbyId === lobbyId ? lobby.metadata : {};
      lobby = {
        lobbyId,
        hostId,
        isHost: false,
        users: Array.isArray(p.users) ? p.users.map((u) => member(u, hostId)) : [],
        metadata: { ...known, ...cleanMeta(p.metadata) },
      };
      settleHost(lobby);
      notify();
    });
    type UsersUpdated = WavedashLobbyUser & { lobbyId?: string; changeType?: string };
    on<UsersUpdated>(ev.LOBBY_USERS_UPDATED, "LobbyUsersUpdated", (p) => {
      if (!lobby || !p || (p.lobbyId && str(p.lobbyId) !== lobby.lobbyId)) return;
      const listed = users(sdk, lobby.lobbyId);
      const hostId = hostOf(sdk, lobby.lobbyId);
      const same = (u: LobbyMember) => (p.userId ? u.userId === str(p.userId) : u.username === str(p.username));
      if (listed) lobby.users = listed.map((u) => member(u, hostId ?? lobby!.hostId));
      else if (p.changeType === "JOINED" && !lobby.users.some(same)) lobby.users.push(member(p, lobby.hostId));
      else if (p.changeType === "LEFT") lobby.users = lobby.users.filter((u) => !same(u));
      // Hosting passes to the next member when the host leaves; without the SDK's word, assume the first one left.
      if (hostId) lobby.hostId = hostId;
      else if (!lobby.users.some((u) => u.userId === lobby!.hostId)) lobby.hostId = lobby.users[0]?.userId ?? "";
      settleHost(lobby);
      notify();
    });
    on<unknown>(ev.LOBBY_DATA_UPDATED, "LobbyDataUpdated", (p) => {
      if (!lobby || !p || typeof p !== "object") return;
      lobby.metadata = cleanMeta(p); // the whole map
      notify();
    });
    type Message = { lobbyId?: string; userId?: string; username?: string; message?: string; timestamp?: number };
    on<Message>(ev.LOBBY_MESSAGE, "LobbyMessage", (p) => {
      if (!p) return;
      const lobbyId = str(p.lobbyId) || lobby?.lobbyId || "";
      emit(messages, { lobbyId, userId: str(p.userId), username: str(p.username) || "Player", message: str(p.message), timestamp: Number(p.timestamp) || Date.now() }, "lobby message");
    });
    on<unknown>(ev.LOBBY_KICKED, "LobbyKicked", () => {
      lobby = null;
      notify();
    });
    type Invite = { lobbyId?: string; sender?: { _id?: string; id?: string; userId?: string; username?: string } };
    on<Invite>(ev.LOBBY_INVITE, "LobbyInvite", (p) => {
      if (!p?.lobbyId) return;
      const senderId = str(p.sender?.userId || p.sender?.id || p.sender?._id);
      emit(invites, { lobbyId: str(p.lobbyId), ...(senderId ? { senderId } : {}), senderName: str(p.sender?.username) || "A friend" }, "lobby invite");
    });
    if (p2p) {
      type Peer = { userId?: string; peerId?: string; username?: string };
      const peer = (state: P2PPeerEvent["state"]) => (p: Peer | undefined) => {
        const userId = str(p?.userId || p?.peerId);
        if (!userId && !p?.username) return;
        emit(peers, { userId, ...(p?.username ? { username: str(p.username) } : {}), state }, "peer");
      };
      on<Peer>(ev.P2P_CONNECTION_ESTABLISHED, "P2PConnectionEstablished", peer("connected"));
      on<Peer>(ev.P2P_PEER_RECONNECTING, "P2PPeerReconnecting", peer("reconnecting"));
      on<Peer>(ev.P2P_PEER_RECONNECTED, "P2PPeerReconnected", peer("reconnected"));
      on<Peer>(ev.P2P_PEER_DISCONNECTED, "P2PPeerDisconnected", peer("disconnected"));
    }
  };

  const list = async (friendsOnly = false): Promise<LobbySummary[] | null> => {
    attach();
    const sdk = getSdk();
    if (!sdk?.listAvailableLobbies) return null;
    try {
      const r = await sdk.listAvailableLobbies(friendsOnly);
      if (!r?.success || !Array.isArray(r.data)) {
        console.warn("[wavedash] listAvailableLobbies failed:", r?.message ?? r);
        return null;
      }
      return r.data.filter((l) => l?.lobbyId).map(summary);
    } catch (e) {
      console.warn("[wavedash] listAvailableLobbies threw", e);
      return null;
    }
  };

  const create: LobbyService["create"] = async (options = {}) => {
    attach(); // LOBBY_JOINED must be listened for before the call
    const sdk = getSdk();
    if (!sdk?.createLobby) return null;
    const v = options.visibility ?? "public";
    const visibility = v === "friends" ? sdk.LobbyVisibility?.FRIENDS_ONLY ?? VISIBILITY.friends
      : v === "private" ? sdk.LobbyVisibility?.PRIVATE ?? VISIBILITY.private
      : sdk.LobbyVisibility?.PUBLIC ?? VISIBILITY.public;
    const max = options.maxPlayers;
    try {
      // Creating joins: never follow it with joinLobby (that fires LOBBY_JOINED again and rebuilds every P2P connection).
      const r = Number.isFinite(max) && max! >= 1 ? await sdk.createLobby(visibility, Math.floor(max!)) : await sdk.createLobby(visibility);
      if (!r?.success || !r.data) {
        console.warn("[wavedash] createLobby failed:", r?.message ?? r);
        return null;
      }
      return settle(str(r.data), true);
    } catch (e) {
      console.warn("[wavedash] createLobby threw", e);
      return null;
    }
  };

  const join = async (lobbyId: string, known: Meta = {}): Promise<LobbyState | null> => {
    attach();
    const sdk = getSdk();
    if (!sdk?.joinLobby || !lobbyId) return null;
    if (lobby?.lobbyId === lobbyId) return copy(lobby); // joining again would rebuild every P2P connection
    try {
      let meta = known;
      if (!Object.keys(meta).length && sdk.getLobby) {
        try {
          const pre = await sdk.getLobby(lobbyId);
          if (pre?.success && pre.data) meta = cleanMeta(pre.data.metadata);
        } catch { /* the metadata arrives with the join event anyway */ }
      }
      const r = await sdk.joinLobby(lobbyId);
      if (!r?.success) {
        console.warn(`[wavedash] joinLobby("${lobbyId}") failed:`, r?.message ?? r);
        return null;
      }
      return settle(lobbyId, false, meta);
    } catch (e) {
      console.warn(`[wavedash] joinLobby("${lobbyId}") threw`, e);
      return null;
    }
  };

  const findOrCreate: LobbyService["findOrCreate"] = (options = {}) => {
    // A second call while one is running (a double click) waits for the first rather than making a second lobby.
    finding ??= (async () => {
      try {
        const listed = (await list(options.friendsOnly ?? false)) ?? [];
        const open = listed.filter((l) => {
          if (l.maxPlayers !== undefined && l.playerCount >= l.maxPlayers) return false;
          try { return options.filter ? options.filter(l) : true; } catch (e) {
            console.warn("[wavedash] a lobby filter failed", e);
            return false;
          }
        });
        for (const candidate of open) {
          const joined = await join(candidate.lobbyId, candidate.metadata);
          if (joined) return joined;
        }
        return await create({ maxPlayers: options.maxPlayers, visibility: options.visibility });
      } finally {
        finding = null;
      }
    })();
    return finding;
  };

  const p2pService: P2PService | undefined = p2p
    ? (() => {
        const channelOk = (c: number) => Number.isInteger(c) && c >= 0 && c < P2P_CHANNELS;
        const maxPayloadBytes = () => {
          try {
            const n = Number(getSdk()?.getP2PMaxPayloadSize?.());
            if (Number.isFinite(n) && n > 0) return n;
          } catch { /* fall back to the configured slot */ }
          return p2p.messageSize - P2P_RECORD_HEADER;
        };
        const sendable = (payload: Uint8Array, channel: number) =>
          channelOk(channel) && payload instanceof Uint8Array && payload.byteLength > 0 && payload.byteLength <= maxPayloadBytes();
        return {
          maxPayloadBytes,
          broadcast(payload, options = {}) {
            const sdk = getSdk();
            const channel = options.channel ?? 0;
            if (!sdk?.broadcastP2PMessage || !lobby || !sendable(payload, channel)) return false;
            try { return sdk.broadcastP2PMessage(channel, options.reliable ?? true, payload) === true; } catch (e) {
              console.warn("[wavedash] broadcastP2PMessage threw", e);
              return false;
            }
          },
          send(userId, payload, options = {}) {
            const sdk = getSdk();
            const channel = options.channel ?? 0;
            if (!sdk?.sendP2PMessage || !lobby || !userId || !sendable(payload, channel)) return false;
            try { return sdk.sendP2PMessage(userId, channel, options.reliable ?? true, payload, payload.byteLength) === true; } catch (e) {
              console.warn("[wavedash] sendP2PMessage threw", e);
              return false;
            }
          },
          read(channel = 0): P2PMessage | null {
            const sdk = getSdk();
            if (!sdk?.readP2PMessageFromChannel || !channelOk(channel)) return null;
            try {
              const m = sdk.readP2PMessageFromChannel(channel);
              if (!m?.payload) return null;
              return { fromUserId: str(m.fromUserId), channel: Number.isInteger(m.channel) ? m.channel! : channel, payload: m.payload };
            } catch {
              return null;
            }
          },
          onPeer(listener) {
            attach();
            peers.add(listener);
            return () => void peers.delete(listener);
          },
        } satisfies P2PService;
      })()
    : undefined;

  return {
    getUser() {
      const sdk = getSdk();
      try {
        const id = myId();
        return id ? { id, username: str(sdk?.getUser?.()?.username || sdk?.getUsername?.()) || "Player" } : null;
      } catch {
        return null;
      }
    },
    launchLobbyId() {
      try { return str(getSdk()?.getLaunchParams?.()?.lobby) || null; } catch { return null; }
    },
    list: (options) => list(options?.friendsOnly ?? false),
    create,
    join: (lobbyId) => join(lobbyId),
    findOrCreate,
    async leave() {
      const id = lobby?.lobbyId;
      if (!id) return;
      lobby = null;
      notify();
      try { await getSdk()?.leaveLobby?.(id); } catch (e) { console.warn("[wavedash] leaveLobby threw", e); }
    },
    current: () => copy(lobby),
    setData(key, value) {
      const sdk = getSdk();
      if (!sdk || !lobby || !key || (value !== null && !isValue(value))) return false;
      if (value === null ? !(key in lobby.metadata) : lobby.metadata[key] === value) return true;
      try {
        const ok = value === null && sdk.deleteLobbyData ? sdk.deleteLobbyData(lobby.lobbyId, key) : sdk.setLobbyData?.(lobby.lobbyId, key, value);
        if (ok !== true) return false;
        if (value === null) delete lobby.metadata[key];
        else lobby.metadata[key] = value;
        notify();
        return true;
      } catch (e) {
        console.warn("[wavedash] setLobbyData threw", e);
        return false;
      }
    },
    getData(key, lobbyId) {
      const id = lobbyId ?? lobby?.lobbyId;
      if (!id) return null;
      if (lobby?.lobbyId === id && key in lobby.metadata) return lobby.metadata[key];
      try {
        const v = getSdk()?.getLobbyData?.(id, key);
        return isValue(v) ? v : null;
      } catch {
        return null;
      }
    },
    sendMessage(message) {
      const sdk = getSdk();
      if (!sdk?.sendLobbyMessage || !lobby || !message || message.length > LOBBY_MESSAGE_MAX) return false;
      try { return sdk.sendLobbyMessage(lobby.lobbyId, message) === true; } catch (e) {
        console.warn("[wavedash] sendLobbyMessage threw", e);
        return false;
      }
    },
    async invite(userId) {
      const sdk = getSdk();
      if (!sdk?.inviteUserToLobby || !lobby || !userId) return false;
      try { return !!(await sdk.inviteUserToLobby(lobby.lobbyId, userId))?.success; } catch (e) {
        console.warn("[wavedash] inviteUserToLobby threw", e);
        return false;
      }
    },
    async inviteLink(options = {}) {
      const sdk = getSdk();
      if (!sdk?.getLobbyInviteLink || !lobby) return null;
      try {
        const r = await sdk.getLobbyInviteLink(!!options.copy);
        return r?.success && r.data ? String(r.data) : null;
      } catch (e) {
        console.warn("[wavedash] getLobbyInviteLink threw", e);
        return null;
      }
    },
    onUpdate(listener) {
      attach();
      updates.add(listener);
      return () => void updates.delete(listener);
    },
    onMessage(listener) {
      attach();
      messages.add(listener);
      return () => void messages.delete(listener);
    },
    onInvite(listener) {
      attach();
      invites.add(listener);
      return () => void invites.delete(listener);
    },
    setPresence(status, details) {
      const sdk = getSdk();
      if (!sdk?.updateUserPresence) return;
      try {
        const r = sdk.updateUserPresence({ ...(status ? { status } : {}), ...(details ? { details } : {}) });
        if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch((e) => console.warn("[wavedash] updateUserPresence failed", e));
      } catch (e) {
        console.warn("[wavedash] updateUserPresence threw", e);
      }
    },
    ...(p2pService ? { p2p: p2pService } : {}),
  };
}
