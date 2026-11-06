// The host the game runs on: your own site, Wavedash or CrazyGames. Each host
// gets an adapter (src/platform/*.ts) behind this one interface, and the build
// target picks it (src/platform/index.ts). Game code talks only to `platform`,
// never to a host SDK, so adding a host means adding one adapter.

export type PlatformId = "web" | "wavedash" | "crazygames";
export type AdKind = "midgame" | "rewarded";
/** `done`: watched to the end (grant the reward). `unavailable`: no fill, cooldown, blocked or disabled; carry on. */
export type AdResult = "done" | "unavailable" | "error";

/** Called around an ad that actually plays: mute and block the game on start, restore on end. */
export interface AdHooks {
  started(): void;
  ended(): void;
}

/** The part of Storage a save needs. Host stores (CrazyGames' Data module) implement only this. */
export type SaveStore = Pick<Storage, "getItem" | "setItem">;

/**
 * Host services beyond the frame loop: achievements and stats, leaderboards, paid content and lobbies. Each is optional on `Platform` (a host
 * that lacks one leaves it undefined and the game falls back to its own local version). Every method is safe to call at any time,
 * never throws, and answers `false` / `null` when the host dropped the call, so game code needs no try/catch around them.
 */

/** Stats (numbers per player) and achievements (unlocked once), kept by the host. Identifiers are the game's own strings. */
export interface StatsService {
  /** Read the player's stats and unlocked achievements from the host. Resolves true once they can be read, false when they could not be loaded. Call once at boot. */
  load(): Promise<boolean>;
  /** A stat's value; 0 until `load` has resolved or when the host does not know the id. */
  getStat(id: string): number;
  /**
   * Set a stat to an absolute value (the host saves it within about a second). True when the host took it or the adapter holds it to deliver once
   * the host has loaded (it retries for a while); false for non-finite values or when there is no host to take it.
   * The latest value per id wins; `keepHighest` instead merges a lifetime total or record by maximum.
   */
  setStat(id: string, value: number, options?: { keepHighest?: boolean }): boolean;
  /** Whether the host says this achievement is unlocked (asked per id: Wavedash has no call that lists them). False until `load` has resolved. */
  isUnlocked(id: string): boolean;
  /** Unlock an achievement (idempotent), with the same queue-and-retry promise as `setStat`. */
  unlock(id: string): boolean;
  /** Save everything pending now (call when a round ends; a change in the last second before the tab closes can be lost otherwise). */
  store(): void;
}

export type BoardSort = "asc" | "desc";
export type BoardDisplay = "numeric" | "seconds" | "milliseconds";
/** A leaderboard by the name the game gives it; the host creates it on first use if it can. */
export interface BoardDef {
  readonly name: string;
  readonly sort: BoardSort;
  readonly display: BoardDisplay;
}
export interface BoardEntry {
  rank: number;
  name: string;
  score: number;
  /** This entry is the current player's. */
  me: boolean;
  /** Small key/value context stored with the score (flat strings, numbers, booleans). */
  meta?: Record<string, string | number | boolean>;
}
export interface SubmitResult {
  /** The player's saved standing after this submission. */
  rank: number;
  /** This score became (or tied) the player's saved best. */
  best: boolean;
  /** Where this particular run would have placed, saved or not. */
  runRank: number;
}
export interface LeaderboardService {
  /** Submit a score, keeping only the player's best. Null when the host could not take it. `meta` is clamped to the host's limits. */
  submit(board: BoardDef, score: number, meta?: Record<string, string | number | boolean>): Promise<SubmitResult | null>;
  /** The best `count` entries; an empty list when nobody has scored (or the board does not exist yet). Null when unavailable. */
  top(board: BoardDef, count: number): Promise<BoardEntry[] | null>;
  /** The entries around the player: `ahead` above and `behind` below, the player's own among them. Null when unavailable or the player has no score. */
  around(board: BoardDef, ahead: number, behind: number): Promise<BoardEntry[] | null>;
}

/** One-time unlocks the host sells (Wavedash Paid Content), keyed by the content identifier set in its portal. Ownership is a UI hint: the host enforces it when it serves the locked files. */
export interface PaidContentService {
  /** Ask the host what the player owns. Resolves the set, or null when it could not be read (then keep whatever `owns` last said). */
  refresh(): Promise<ReadonlySet<string> | null>;
  /** From the last `refresh` (and any grant since). */
  owns(id: string): boolean;
  /** Open the host's checkout. Resolves true when the player owns it afterwards (also when they already did). */
  purchase(id: string): Promise<boolean>;
  /** Content granted from any source while the game runs (this checkout, the store page, a gift code). Returns an unsubscribe function. */
  onGranted(listener: (ids: readonly string[]) => void): () => void;
}

/** A lobby metadata value: flat strings, finite numbers and booleans only (the host rejects objects, arrays and NaN). */
export type LobbyValue = string | number | boolean;
/** `public`: listed for everyone. `friends`: listed for friends (`list({ friendsOnly: true })`), joinable by id. `private`: joinable by id only. */
export type LobbyVisibility = "public" | "friends" | "private";

/** A member of the lobby the player is in. */
export interface LobbyMember {
  userId: string;
  username: string;
  avatarUrl?: string;
  isHost: boolean;
}

/** A joinable lobby, as `LobbyService.list()` sees it. */
export interface LobbySummary {
  lobbyId: string;
  visibility: LobbyVisibility;
  /** The lobby's cap, or undefined when the host did not report one. */
  maxPlayers?: number;
  playerCount: number;
  metadata: Record<string, LobbyValue>;
}

/** The lobby the player is in (a copy: changing it changes nothing). */
export interface LobbyState {
  lobbyId: string;
  /** Empty until the host has said who hosts (a join can resolve before its event). */
  hostId: string;
  /** This player hosts it: only the host may write metadata. Hosting passes to another member when the host leaves. */
  isHost: boolean;
  users: LobbyMember[];
  metadata: Record<string, LobbyValue>;
}

/** A lobby chat line. Chat is for people (500 characters at most), not for game state: send that over `LobbyService.p2p`. */
export interface LobbyChatMessage {
  lobbyId: string;
  userId: string;
  username: string;
  message: string;
  timestamp: number;
}

export interface LobbyInvite {
  lobbyId: string;
  senderId?: string;
  senderName: string;
}

export interface LobbyCreateOptions {
  /** The lobby's cap. Omitted: the host's own default. */
  maxPlayers?: number;
  /** Default `public`. */
  visibility?: LobbyVisibility;
}

export interface LobbyFindOptions extends LobbyCreateOptions {
  /** Look among friends' lobbies instead of public ones. */
  friendsOnly?: boolean;
  /** The game's own rule for which listed lobbies to join (a mode, a version, a match that has not ended). Full lobbies are skipped before it is asked. */
  filter?: (lobby: LobbySummary) => boolean;
}

/** One binary message from a peer. */
export interface P2PMessage {
  fromUserId: string;
  channel: number;
  payload: Uint8Array;
}

/** What happened to the connection with one peer. `reconnecting`: unreachable for now, keep its state. `disconnected`: gone (left the lobby, closed the tab, or failed). */
export interface P2PPeerEvent {
  userId: string;
  username?: string;
  state: "connected" | "reconnecting" | "reconnected" | "disconnected";
}

export interface P2PSendOptions {
  /** 0..7 (default 0). Separate channels keep, say, state and input in separate queues. */
  channel?: number;
  /** Default true: delivered and ordered. False: best effort and faster (positions, input). */
  reliable?: boolean;
}

/**
 * Binary messages between the members of the player's lobby (Wavedash P2P: a WebRTC mesh the host builds when players join). Opt-in per game.
 * Sends answer false when nothing was sent (no lobby, no connected peer yet, the channel kind is off, the payload is too big); reads answer null when
 * the channel's queue is empty. Messages are not stored: drain each channel you use every frame.
 */
export interface P2PService {
  /** The largest payload one message may carry, in bytes. */
  maxPayloadBytes(): number;
  /** To every connected peer. True only means it went to the peers that were connected. */
  broadcast(payload: Uint8Array, options?: P2PSendOptions): boolean;
  /** To one peer, by user id. */
  send(userId: string, payload: Uint8Array, options?: P2PSendOptions): boolean;
  /** The next queued message on a channel (default 0), or null. */
  read(channel?: number): P2PMessage | null;
  /** Peers connecting, dropping and coming back. Returns an unsubscribe function. */
  onPeer(listener: (event: P2PPeerEvent) => void): () => void;
}

/**
 * The host's lobbies: matchmaking, a member list, host-written metadata, chat, invites and presence, plus optional P2P. This is the host's
 * matchmaking layer, not a game server: the game decides what a lobby means and keeps its own rules.
 *
 * Create a lobby on an explicit player action (a Quickplay button), not at boot: a public lobby made at boot stays listed while the player idles in
 * the menus. A player is one member per account: two tabs in one browser share one user id, so they cannot be two members or P2P peers.
 */
export interface LobbyService {
  /** The signed-in player, or null when the host has not said. */
  getUser(): { id: string; username: string } | null;
  /** The lobby an invite link opened the game with, or null. The game still has to `join` it (and should fall back when it has gone). */
  launchLobbyId(): string | null;
  /** Joinable lobbies (public, or friends' with `friendsOnly`); an empty list when there are none, null when the host could not be asked. */
  list(options?: { friendsOnly?: boolean }): Promise<LobbySummary[] | null>;
  /** Create a lobby. Creating one joins it (the adapter never joins it a second time). Null on failure. */
  create(options?: LobbyCreateOptions): Promise<LobbyState | null>;
  /** Join a lobby by id; already in it, this answers the current state without asking the host again. Null on failure (gone, full). */
  join(lobbyId: string): Promise<LobbyState | null>;
  /** Join the first listed lobby with room that `filter` accepts, or create one when none takes the player. */
  findOrCreate(options?: LobbyFindOptions): Promise<LobbyState | null>;
  /** Leave the current lobby (no-op when not in one). Closing the tab leaves by itself. */
  leave(): Promise<void>;
  current(): LobbyState | null;
  /** Write (or with null, delete) a metadata key on the current lobby. Host only: false for other members, when not in a lobby, or when the host refused. */
  setData(key: string, value: LobbyValue | null): boolean;
  /** A metadata key of the current lobby (or another one that was joined or fetched), or null. */
  getData(key: string, lobbyId?: string): LobbyValue | null;
  /** Send a chat line to the lobby. False when not in a lobby, empty, longer than `LOBBY_MESSAGE_MAX`, or refused. */
  sendMessage(message: string): boolean;
  /** Invite a user to the current lobby. */
  invite(userId: string): Promise<boolean>;
  /** A shareable link to the current lobby (it opens the game with `launchLobbyId()` set), optionally copied to the clipboard; null when not in a lobby. */
  inviteLink(options?: { copy?: boolean }): Promise<string | null>;
  /** Membership, hosting or metadata changed, or the player left or was removed (null). Returns an unsubscribe function. */
  onUpdate(listener: (state: LobbyState | null) => void): () => void;
  onMessage(listener: (message: LobbyChatMessage) => void): () => void;
  onInvite(listener: (invite: LobbyInvite) => void): () => void;
  /** What the player is doing, for the host's presence (`status` one line, `details` the mode or place). No arguments clears it. */
  setPresence(status?: string, details?: string): void;
  /** Binary messages between lobby members, when the game opted in (Wavedash: game.json `platform.wavedash.p2p`); otherwise undefined. */
  readonly p2p?: P2PService;
}

export interface Platform {
  readonly id: PlatformId;
  /** Host achievements and stats, or undefined when the host has none (the game keeps its own). */
  readonly stats?: StatsService;
  /** Host leaderboards, or undefined. */
  readonly boards?: LeaderboardService;
  /** Host-sold paid content, or undefined (the game then sells nothing for money and keeps its in-game prices). */
  readonly paid?: PaidContentService;
  /** Host lobbies (matchmaking, metadata, chat, invites, optional P2P), or undefined when the host has none (the web and CrazyGames adapters). */
  readonly lobbies?: LobbyService;
  /**
   * A signed token naming the player, for the game's own server (Wavedash: `getUserJwt`, an RS256 JWT that lasts an hour), or undefined
   * where the adapter offers none (the web and CrazyGames adapters). Resolves null when the host gave none; never rejects. Ask for one per
   * connection rather than storing it. The token proves identity only to a server that verifies it: the signature against the host's
   * published keys, the issuer, the audience, a required expiry and the game/environment claim (docs/starter.md). Never trust it unverified.
   */
  userToken?(): Promise<string | null>;
  /** How far through the game the player is, 0..100 (CrazyGames' completion report), or undefined when the host doesn't track it. */
  reportProgress?(percent: number): void;
  /**
   * Send any save change waiting for its debounce to the host's cloud now (a reset that must win over the old cloud copy). Undefined where there is no
   * cloud mirror of the game's own (the website; CrazyGames' Data module keeps its own schedule). Never rejects.
   */
  flush?(): Promise<void>;
  /**
   * This adapter permits first-party telemetry. Off by default on CrazyGames;
   * evaluate the game's host/privacy requirements before changing that policy.
   * Gate any analytics module on it.
   */
  readonly ownAnalytics: boolean;

  /** Connect to the host SDK. Await it before anything reads a save. Never throws; a missing SDK leaves the adapter inert. */
  init(): Promise<void>;
  /** Boot progress 0..1 (the host's loading bar). */
  loading(progress: number): void;
  /** The player can interact (the title screen is up). Settles the host loader once. */
  ready(): void;
  /** Boot failed: release the host loader so the game's own error card is visible. */
  failed(): void;

  /** Real play starts or resumes. Repeated calls are harmless. */
  gameplayStart(): void;
  /** Play stops: menus, results, pause. Not for focus loss (hosts track that themselves). */
  gameplayStop(): void;
  /** A big moment worth a host celebration (use sparingly). */
  celebrate(): void;

  /**
   * Where saves live: the host's store, or this browser's localStorage; null when storage is
   * blocked. Read it at use time, not once at startup: some adapters swap it during init().
   */
  readonly storage: SaveStore | null;
  /** The host asks the game to stay silent; overrides the in-game sound toggle. */
  readonly hostMuted: boolean;
  onHostMute(listener: (muted: boolean) => void): void;

  /** The game may show its own fullscreen button. False on CrazyGames, which prohibits custom fullscreen buttons. */
  readonly ownFullscreen: boolean;
  /**
   * Enter or leave fullscreen; call from a user gesture. Resolves true when the state changed.
   * The only place the Fullscreen API is touched, so builds whose adapter lacks it never contain it.
   */
  toggleFullscreen(): Promise<boolean>;

  /** Whether an offer for this ad kind may be shown now. False means hide the offer: never a dead ad button. */
  canShowAd(kind: AdKind): boolean;
  /** Request an ad; `hooks` fire only if one actually plays. Always resolves. */
  showAd(kind: AdKind, hooks: AdHooks): Promise<AdResult>;
}
