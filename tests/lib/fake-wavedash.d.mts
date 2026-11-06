export interface FakeWavedashOptions {
  statsDelayMs?: number;
  stats?: string[];
  achievements?: string[];
  entitled?: string[];
  paywall?: "grant" | "dismiss" | "error";
  username?: string;
  userId?: string;
  /** What getUserJwt() answers: a string (default `fake-jwt.<userId>`, not a real signed token), or null for a failed call. */
  userJwt?: string | null;
  failStats?: boolean;
  remoteFiles?: Record<string, string>;
  failDownload?: boolean;
  launchParams?: Record<string, string>;
  defaultMaxPlayers?: number;
  failLobbies?: boolean;
  lobbyEventsFirst?: boolean;
}
export interface FakeLobby {
  lobbyId: string;
  visibility: number;
  maxPlayers: number;
  hostId: string;
  users: { userId: string; username: string }[];
  metadata: Record<string, string | number | boolean>;
}
/** Lobbies shared by the fakes created with it (one fake per player). */
export interface FakeWavedashHub {
  lobbies: Record<string, FakeLobby>;
  clients: { userId: string; username: string }[];
  next: number;
}
export interface FakeWavedashInspector {
  log: { name: string; args: unknown[]; at: number }[];
  state: {
    statsLoaded: boolean;
    stats: Record<string, number>;
    achievements: Record<string, boolean>;
    boards: Record<string, { id: string; sort: number; display: number; entries: { userId: string; username: string; score: number; metadata?: Record<string, unknown>; ts: number }[] }>;
    entitlements: Set<string>;
    initCalls: number;
    loadComplete: boolean;
    progress: number;
    files: Map<string, unknown>;
    paywallCalls: string[];
    p2pConfig: Record<string, unknown> | null;
    p2pRebuilds: number;
    presence: Record<string, unknown> | null;
    inbox: Map<number, { fromUserId: string; channel: number; payload: Uint8Array }[]>;
    dropped: number;
  };
  hub: FakeWavedashHub;
  kick(lobbyId: string, reason?: string): void;
  grant(...ids: string[]): void;
  revoke(...ids: string[]): void;
  calls(name: string): { name: string; args: unknown[]; at: number }[];
  dumpRemote(): Record<string, string>;
}
export type FakeWavedash = Record<string, unknown> & { __wd: FakeWavedashInspector };
export function createFakeWavedashHub(): FakeWavedashHub;
export function createFakeWavedash(options?: FakeWavedashOptions, hub?: FakeWavedashHub | null): FakeWavedash;
export function fakeWavedashSource(options?: FakeWavedashOptions): string;
