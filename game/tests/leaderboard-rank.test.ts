import { describe, expect, it } from "vitest";
import { wavedashRows } from "../src/leaderboard";

const e = (rank: number, name: string, score: number, nuts: number, me = false) => ({ rank, name, score, meta: { nuts }, me }) as any;

describe("wavedash leaderboard ranking", () => {
  it("re-sorts host rows by distance then nuts and re-ranks 1..n", () => {
    const out = wavedashRows([e(1, "a", 420, 64), e(2, "b", 420, 56), e(3, "c", 420, 68), e(4, "d", 300, 99)], null);
    expect(out.entries.map((r) => [r.rank, r.username])).toEqual([[1, "c"], [2, "a"], [3, "b"], [4, "d"]]);
  });
  it("keeps host order on full ties", () => {
    const { entries } = wavedashRows([e(1, "x", 500, 10), e(2, "y", 500, 10)], null);
    expect(entries.map((r) => r.username)).toEqual(["x", "y"]);
  });
});
