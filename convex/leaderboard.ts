import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const MAX_DISTANCE = 100000; // sanity bounds, not anti-cheat
const MAX_NUTS = 10000;
const cleanName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "Guest";

/** Register (or rename) a guest; idempotent per guestId. */
export const ensurePlayer = mutation({
  args: { guestId: v.string(), username: v.string() },
  handler: async (ctx, { guestId, username }) => {
    if (guestId.length < 8 || guestId.length > 64) throw new Error("bad guestId");
    const name = cleanName(username);
    const found = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    if (found) {
      if (found.username !== name) await ctx.db.patch(found._id, { username: name });
      return found._id;
    }
    return await ctx.db.insert("players", { guestId, username: name, createdAt: Date.now(), bestDistance: 0, bestNuts: 0, bestAt: 0, runs: 0 });
  },
});

/** Record one finished run and update the guest's best. */
export const submitRun = mutation({
  args: { guestId: v.string(), username: v.string(), distance: v.number(), nuts: v.number(), won: v.boolean() },
  handler: async (ctx, a) => {
    if (a.guestId.length < 8 || a.guestId.length > 64) throw new Error("bad guestId");
    const distance = Math.max(0, Math.min(MAX_DISTANCE, Math.round(a.distance)));
    const nuts = Math.max(0, Math.min(MAX_NUTS, Math.round(a.nuts)));
    const name = cleanName(a.username);
    const now = Date.now();
    let p = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", a.guestId)).unique();
    if (!p) {
      const id = await ctx.db.insert("players", { guestId: a.guestId, username: name, createdAt: now, bestDistance: 0, bestNuts: 0, bestAt: 0, runs: 0 });
      p = (await ctx.db.get(id))!;
    }
    await ctx.db.insert("runs", { playerId: p._id, username: name, distance, nuts, won: a.won, createdAt: now });
    const better = distance > p.bestDistance || (distance === p.bestDistance && nuts > p.bestNuts);
    await ctx.db.patch(p._id, {
      username: name,
      runs: p.runs + 1,
      coins: (p.coins ?? 0) + nuts, // bank every collected nut
      ...(better ? { bestDistance: distance, bestNuts: nuts, bestAt: now } : {}),
    });
    return { best: better, distance, nuts };
  },
});

/** Top guests by best distance, then nuts. `rank` is set for the asking guest if outside the top. */
export const top = query({
  args: { limit: v.optional(v.number()), guestId: v.optional(v.string()) },
  handler: async (ctx, { limit, guestId }) => {
    const n = Math.max(1, Math.min(50, limit ?? 10));
    // Index order breaks exact ties newest-first; re-sort a slightly wider window so the earlier best wins a tie.
    const rows = (await ctx.db.query("players").withIndex("by_best", (q) => q.gt("bestDistance", 0)).order("desc").take(n + 20))
      .sort((a, b) => b.bestDistance - a.bestDistance || b.bestNuts - a.bestNuts || a.bestAt - b.bestAt)
      .slice(0, n);
    const entries = rows.map((p, i) => ({ rank: i + 1, username: p.username, distance: p.bestDistance, nuts: p.bestNuts, me: !!guestId && p.guestId === guestId }));
    let me: { rank: number; username: string; distance: number; nuts: number } | null = null;
    if (guestId && !entries.some((e) => e.me)) {
      const p = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
      if (p && p.bestDistance > 0) {
        // Count of guests strictly ahead (bounded read; fine at this scale).
        const ahead = await ctx.db.query("players").withIndex("by_best", (q) => q.gt("bestDistance", p.bestDistance)).take(1000);
        const tied = await ctx.db.query("players").withIndex("by_best", (q) => q.eq("bestDistance", p.bestDistance).gte("bestNuts", p.bestNuts)).take(1000);
        const tiedAhead = tied.filter((o) => o.bestNuts > p.bestNuts || (o.bestAt < p.bestAt && o._id !== p._id)).length;
        me = { rank: ahead.length + tiedAhead + 1, username: p.username, distance: p.bestDistance, nuts: p.bestNuts };
      }
    }
    return { entries, me };
  },
});

/** Wallet + entitlements for any identity (guest UUID, auth:, wd:). */
export const wallet = query({
  args: { guestId: v.string() },
  handler: async (ctx, { guestId }) => {
    const p = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    return { coins: p?.coins ?? 0, unlocks: p?.unlocks ?? [] };
  },
});
