// Authenticated player profile (web Convex Auth). Guests and Wavedash use leaderboard.ensurePlayer instead.
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const cleanName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
const NAME_MIN = 2;

/** Current signed-in player's leaderboard profile, or null if anonymous. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const guestId = `auth:${userId}`.slice(0, 64);
    const player = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    // Race: afterUserCreatedOrUpdated may not have finished; synthesise a read-only view.
    if (!player) {
      const accounts = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
        .collect();
      const provider = accounts[0]?.provider ?? "unknown";
      return {
        guestId,
        username: cleanName(user?.name ?? "Driver") || "Driver",
        provider,
        needsUsernameConfirm: provider === "google",
        image: user?.image ?? null,
        coins: 0,
        unlocks: [] as string[],
        linked: false,
      };
    }
    return {
      guestId: player.guestId,
      username: player.username,
      provider: player.provider ?? null,
      needsUsernameConfirm: !!player.needsUsernameConfirm,
      image: user?.image ?? null,
      coins: player.coins ?? 0,
      unlocks: player.unlocks ?? [],
      linked: !!player.linkedGuestId,
    };
  },
});

/** Google first-login modal: set final username and clear the confirm flag. */
export const confirmUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    const name = cleanName(username);
    if (!name || name.length < NAME_MIN) throw new Error("bad username");
    const guestId = `auth:${userId}`.slice(0, 64);
    const player = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    if (!player) {
      const id = await ctx.db.insert("players", {
        guestId,
        username: name,
        createdAt: Date.now(),
        bestDistance: 0,
        bestNuts: 0,
        bestAt: 0,
        runs: 0,
        authUserId: userId,
        provider: "google",
        needsUsernameConfirm: false,
      });
      return { username: name, playerId: id };
    }
    await ctx.db.patch(player._id, { username: name, needsUsernameConfirm: false });
    return { username: name, playerId: player._id };
  },
});

/** Rename for signed-in users (GitHub / X defaults, or Google after confirm). */
export const setUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    const name = cleanName(username);
    if (!name || name.length < NAME_MIN) throw new Error("bad username");
    const guestId = `auth:${userId}`.slice(0, 64);
    const player = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    if (!player) throw new Error("no player");
    if (player.needsUsernameConfirm) throw new Error("confirm first");
    await ctx.db.patch(player._id, { username: name });
    return { username: name };
  },
});

/**
 * First-link merge: fold the browser's anonymous guest row (+ local unlock flags) into the signed-in player.
 * Runs once per auth player (linkedGuestId set). Rules: coins add; unlocks union; best run = max; runs add;
 * Google: guest name becomes the modal prefill (still needs confirm); GitHub/X keep their handle.
 * Guest row is zeroed + marked mergedInto so coins can't be double-claimed by another account.
 */
export const linkGuest = mutation({
  args: { guestId: v.string(), localUnlocks: v.optional(v.array(v.string())), guestName: v.optional(v.string()) },
  handler: async (ctx, { guestId, localUnlocks, guestName }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    if (guestId.length < 8 || guestId.length > 64 || guestId.includes(":")) throw new Error("bad guestId");
    const authGuestId = `auth:${userId}`.slice(0, 64);
    const player = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", authGuestId)).unique();
    if (!player) return { merged: false, reason: "no player" };
    if (player.linkedGuestId) return { merged: false, reason: "already linked" };
    const g = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    const unlocks = Array.from(new Set([...(player.unlocks ?? []), ...(g?.mergedInto ? [] : (g?.unlocks ?? [])), ...(localUnlocks ?? [])].map(String).filter((s) => /^[a-z0-9_]{1,32}$/.test(s)))).slice(0, 64);
    const patch: Record<string, unknown> = { linkedGuestId: guestId, unlocks };
    if (g && !g.mergedInto) {
      patch.coins = (player.coins ?? 0) + (g.coins ?? 0);
      patch.runs = player.runs + g.runs;
      if (g.bestDistance > player.bestDistance || (g.bestDistance === player.bestDistance && g.bestNuts > player.bestNuts)) {
        Object.assign(patch, { bestDistance: g.bestDistance, bestNuts: g.bestNuts, bestAt: g.bestAt });
      }
      // Guest row leaves the board (best moved) and its wallet is spent.
      await ctx.db.patch(g._id, { coins: 0, unlocks: [], bestDistance: 0, bestNuts: 0, mergedInto: authGuestId });
    }
    const gName = cleanName(guestName ?? g?.username ?? "");
    if (player.needsUsernameConfirm && gName.length >= NAME_MIN) patch.username = gName;
    await ctx.db.patch(player._id, patch);
    return { merged: true };
  },
});
