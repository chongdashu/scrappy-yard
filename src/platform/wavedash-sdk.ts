// The parts of the injected `window.Wavedash` the adapter uses (docs.wavedash.com/sdk, @wvdsh/sdk-js 1.3.x). Every member is optional: the
// adapter works against whatever the host injected, and a member that is missing simply leaves its feature inert. The npm package is not
// imported (it throws at import time without the injected global), so this is our own narrow copy of the shapes.

/** What an async SDK call answers: `success` first, then `data`, or a `message` when it failed. */
export type Reply<T> = { success?: boolean; data?: T; message?: string } | undefined;

/** A leaderboard row as Wavedash returns it. */
export interface WavedashEntry {
  userId?: string;
  username?: string;
  score?: number;
  globalRank?: number;
  metadata?: Record<string, string | number | boolean>;
}

/** Wavedash's UpsertedLeaderboardEntry: the saved standing (the best, with keepBest) and this run's. */
export interface Upserted {
  score?: number;
  scoreChanged?: boolean;
  globalRank?: number;
  submittedRank?: number;
}

/** A lobby member as the SDK reports it (LOBBY_JOINED's `users`, `getLobbyUsers`). */
export interface WavedashLobbyUser {
  userId?: string;
  username?: string;
  userAvatarUrl?: string;
  isHost?: boolean;
}

/** A lobby as `listAvailableLobbies` / `getLobby` return it. Visibility 0 public, 1 friends only, 2 private. */
export interface WavedashLobby {
  lobbyId?: string;
  visibility?: number;
  maxPlayers?: number;
  playerCount?: number;
  metadata?: Record<string, string | number | boolean>;
}

/** `init({ p2p })`. The SDK's documented defaults: both channel kinds on, 2048-byte message slots (45..65536), 1024 queued messages per channel. */
export interface WavedashP2PConfig {
  enableReliableChannel?: boolean;
  enableUnreliableChannel?: boolean;
  messageSize?: number;
  maxIncomingMessages?: number;
}

export interface WavedashSdk {
  updateLoadProgressZeroToOne?(progress: number): void;
  init?(options: { debug: boolean; p2p?: WavedashP2PConfig }): boolean;
  loadComplete?(): void;
  Events?: {
    ENTITLEMENTS_GRANTED?: string;
    LOBBY_JOINED?: string;
    LOBBY_USERS_UPDATED?: string;
    LOBBY_MESSAGE?: string;
    LOBBY_DATA_UPDATED?: string;
    LOBBY_KICKED?: string;
    LOBBY_INVITE?: string;
    P2P_CONNECTION_ESTABLISHED?: string;
    P2P_PEER_RECONNECTING?: string;
    P2P_PEER_RECONNECTED?: string;
    P2P_PEER_DISCONNECTED?: string;
  };
  LobbyVisibility?: { PUBLIC?: number; FRIENDS_ONLY?: number; PRIVATE?: number };
  /** Payload shapes are per event (the docs give examples, not schemas), so listeners read them defensively. */
  on?<T = unknown>(event: string, listener: (payload: T) => void): (() => void) | void;
  getUser?(): { id?: string; username?: string } | null;
  getUserId?(): string;
  /**
   * The player's gameplay JWT for a game's own server (docs.wavedash.com/sdk/players): RS256, issuer https://auth.wavedash.com, audience
   * gameplay.wavedash.com, one hour; keys at https://auth.wavedash.com/.well-known/jwks.json. Claims include `sub` (the player), `scope`
   * ("gameplay"), `gcid` (the game cloud id: playtest and production differ), `ents` (owned content) and `exp`.
   */
  getUserJwt?(): Promise<Reply<string>>;
  getUsername?(): string;
  getLaunchParams?(): Record<string, string | undefined> | null;
  /** Presence: optional `status` and `details`; `{}` clears it. */
  updateUserPresence?(data: { status?: string; details?: string }): Promise<unknown> | unknown;

  // Lobbies (docs.wavedash.com/multiplayer/lobbies). Creating a lobby joins it: calling joinLobby on it fires LOBBY_JOINED again and rebuilds
  // every P2P connection. Only the host may write lobby data; chat lines are capped at 500 characters.
  createLobby?(visibility: number, maxPlayers?: number): Promise<Reply<string>>;
  joinLobby?(lobbyId: string): Promise<Reply<unknown>>;
  leaveLobby?(lobbyId: string): Promise<Reply<unknown>>;
  listAvailableLobbies?(friendsOnly?: boolean): Promise<Reply<WavedashLobby[]>>;
  getLobby?(lobbyId: string): Promise<Reply<WavedashLobby>>;
  getLobbyUsers?(lobbyId: string): WavedashLobbyUser[] | null;
  getLobbyHostId?(lobbyId: string): string | null;
  sendLobbyMessage?(lobbyId: string, message: string): boolean;
  inviteUserToLobby?(lobbyId: string, userId: string): Promise<Reply<unknown>>;
  setLobbyData?(lobbyId: string, key: string, value: string | number | boolean | null): boolean;
  getLobbyData?(lobbyId: string, key: string): string | number | boolean | null;
  deleteLobbyData?(lobbyId: string, key: string): boolean;
  getLobbyInviteLink?(copyToClipboard?: boolean): Promise<Reply<string>>;

  // P2P (docs.wavedash.com/multiplayer/networking): channels 0..7; a false send means nothing was sent.
  broadcastP2PMessage?(channel: number, reliable: boolean, payload: Uint8Array): boolean;
  sendP2PMessage?(userId: string | undefined, channel: number, reliable: boolean, payload: Uint8Array, payloadSize?: number): boolean;
  readP2PMessageFromChannel?(channel: number): { fromUserId?: string; channel?: number; payload?: Uint8Array } | null;
  getP2PMaxPayloadSize?(): number;

  // Stats and achievements. setStat / setAchievement answer false and DROP the write until requestStats has loaded, and for ids the project lacks.
  requestStats?(): Promise<Reply<boolean>>;
  getStat?(id: string): number;
  setStat?(id: string, value: number, storeNow?: boolean): boolean;
  getAchievement?(id: string): boolean;
  setAchievement?(id: string, storeNow?: boolean): boolean;
  storeStats?(): boolean;

  // Leaderboards. Only get/getOrCreate take the name; everything else takes the id they return. sort 0 ascending, 1 descending; display 0 numeric, 1 seconds, 2 milliseconds.
  getLeaderboard?(name: string): Promise<Reply<{ id?: string }>>;
  getOrCreateLeaderboard?(name: string, sort: number, display: number): Promise<Reply<{ id?: string }>>;
  uploadLeaderboardScore?(id: string, score: number, keepBest: boolean, ugcId?: string, metadata?: Record<string, string | number | boolean>): Promise<Reply<Upserted>>;
  listLeaderboardEntries?(id: string, offset: number, limit: number, friendsOnly?: boolean): Promise<Reply<WavedashEntry[]>>;
  listLeaderboardEntriesAroundUser?(id: string, ahead: number, behind: number, friendsOnly?: boolean): Promise<Reply<WavedashEntry[]>>;

  // Paid Content.
  getEntitlements?(): Promise<Reply<string[]>>;
  triggerPaywall?(contentIdentifier: string): Promise<Reply<boolean>>;

  // Remote Storage: files in the SDK's local store, uploaded to / downloaded from the cloud.
  writeLocalFile?(path: string, data: Uint8Array): Promise<boolean>;
  readLocalFile?(path: string): Promise<Uint8Array | null>;
  uploadRemoteFile?(path: string): Promise<Reply<string>>;
  downloadRemoteFile?(path: string): Promise<Reply<string>>;
  remoteFileExists?(path: string): Promise<Reply<boolean>>;
}
