// Wavedash board → Top Scrappers rows: distance is the score, nuts come from metadata, and the player's own row is added below the top
// only when they are not already in it.
import { describe, expect, it } from "vitest";
import { WAVEDASH_BOARD, wavedashRows } from "../src/leaderboard";

describe("wavedash leaderboard mapping", () => {
  it("names a descending numeric distance board", () => {
    expect(WAVEDASH_BOARD).toEqual({ name: "distance", sort: "desc", display: "numeric" });
  });
  it("maps score to distance and meta.nuts to nuts", () => {
    const { entries, me } = wavedashRows(
      [
        { rank: 1, name: "Ace", score: 812.4, me: false, meta: { nuts: 31, won: true } },
        { rank: 2, name: "Me", score: 500, me: true, meta: { nuts: 12 } },
        { rank: 3, name: "NoMeta", score: 90, me: false },
      ],
      null,
    );
    expect(entries).toEqual([
      { rank: 1, username: "Ace", distance: 812, nuts: 31, me: false },
      { rank: 2, username: "Me", distance: 500, nuts: 12, me: true },
      { rank: 3, username: "NoMeta", distance: 90, nuts: 0, me: false },
    ]);
    expect(me).toBeNull();
  });
  it("adds the player's own row from around() when outside the top", () => {
    const { me } = wavedashRows([{ rank: 1, name: "Ace", score: 800, me: false, meta: { nuts: 3 } }], [
      { rank: 42, name: "Me", score: 120, me: true, meta: { nuts: 4 } },
    ]);
    expect(me).toEqual({ rank: 42, username: "Me", distance: 120, nuts: 4, me: true });
  });
});

describe("on a Wavedash host (fake SDK)", () => {
  it("submits distance with nuts metadata to the host board and reads the menu board from it", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("VITE_CONVEX_URL", ""); // never touch a real Convex deployment from tests
    vi.resetModules();
    // @ts-expect-error untyped test helper
    const { createFakeWavedash } = await import("../../tests/lib/fake-wavedash.mjs");
    const sdk = createFakeWavedash({ userId: "u123", username: "WaveRacer" });
    (globalThis as { Wavedash?: unknown }).Wavedash = sdk;
    try {
      const { platform } = await import("@engine/platform");
      await platform.init();
      expect(platform.id).toBe("wavedash");
      const lb = await import("../src/leaderboard");
      lb.startLeaderboard(); // no document: identity is still adopted at submit time
      await lb.submitRun(321.6, 17, false);
      const top = await platform.boards!.top(lb.WAVEDASH_BOARD, 5);
      expect(top?.[0]).toMatchObject({ name: "WaveRacer", score: 322, me: true, meta: { nuts: 17, won: false } });
    } finally {
      delete (globalThis as { Wavedash?: unknown }).Wavedash;
      vi.unstubAllEnvs();
    }
  });
});
