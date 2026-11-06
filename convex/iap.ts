// Skin unlock mutations (web DodoPayments + guest/auth player rows).
import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { PRODUCT_BY_SKU, SKU_RE } from "./iapProducts";

const MAX_UNLOCKS = 64;

function cleanSku(raw: string): string | null {
  const s = String(raw ?? "").trim();
  return SKU_RE.test(s) && PRODUCT_BY_SKU[s] ? s : null;
}

/** Public client grants are not exposed — only the Dodo webhook path (grantUnlockInternal) may append SKUs. */

/** Internal grant used by the Dodo webhook path (same rules as grantUnlock). */
export const grantUnlockInternal = internalMutation({
  args: { guestId: v.string(), sku: v.string(), webhookId: v.string(), paymentId: v.optional(v.string()) },
  handler: async (ctx, { guestId, sku, webhookId, paymentId }) => {
    const seen = await ctx.db.query("dodoWebhooks").withIndex("by_webhook", (q) => q.eq("webhookId", webhookId)).unique();
    if (seen) return { ok: true, duplicate: true, sku: seen.sku ?? null };

    const id = cleanSku(sku);
    if (!id) {
      await ctx.db.insert("dodoWebhooks", {
        webhookId,
        processedAt: Date.now(),
        type: "payment.succeeded",
        sku: undefined,
        playerId: guestId,
        paymentId,
        note: "bad sku",
      });
      return { ok: false, reason: "bad sku" };
    }
    if (guestId.length < 8 || guestId.length > 64) {
      await ctx.db.insert("dodoWebhooks", {
        webhookId,
        processedAt: Date.now(),
        type: "payment.succeeded",
        sku: id,
        playerId: guestId,
        paymentId,
        note: "bad player_id",
      });
      return { ok: false, reason: "bad player_id" };
    }

    let p = await ctx.db.query("players").withIndex("by_guest", (q) => q.eq("guestId", guestId)).unique();
    if (!p) {
      await ctx.db.insert("players", {
        guestId,
        username: "Guest",
        createdAt: Date.now(),
        bestDistance: 0,
        bestNuts: 0,
        bestAt: 0,
        runs: 0,
        unlocks: [id],
      });
    } else {
      const unlocks = Array.from(new Set([...(p.unlocks ?? []), id])).slice(0, MAX_UNLOCKS);
      if (unlocks.length !== (p.unlocks ?? []).length) await ctx.db.patch(p._id, { unlocks });
    }

    await ctx.db.insert("dodoWebhooks", {
      webhookId,
      processedAt: Date.now(),
      type: "payment.succeeded",
      sku: id,
      playerId: guestId,
      paymentId,
    });
    return { ok: true, duplicate: false, sku: id };
  },
});

/** Record a non-grant webhook (processing / failed / cancelled) for idempotency. */
export const recordWebhook = internalMutation({
  args: {
    webhookId: v.string(),
    type: v.string(),
    sku: v.optional(v.string()),
    playerId: v.optional(v.string()),
    paymentId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const seen = await ctx.db.query("dodoWebhooks").withIndex("by_webhook", (q) => q.eq("webhookId", a.webhookId)).unique();
    if (seen) return { duplicate: true };
    await ctx.db.insert("dodoWebhooks", {
      webhookId: a.webhookId,
      processedAt: Date.now(),
      type: a.type,
      sku: a.sku,
      playerId: a.playerId,
      paymentId: a.paymentId,
      note: a.note,
    });
    return { duplicate: false };
  },
});

export const webhookSeen = internalQuery({
  args: { webhookId: v.string() },
  handler: async (ctx, { webhookId }) => {
    const seen = await ctx.db.query("dodoWebhooks").withIndex("by_webhook", (q) => q.eq("webhookId", webhookId)).unique();
    return !!seen;
  },
});

/** Public product map for the client (ids only; no secrets). */
export const catalog = query({
  args: {},
  handler: async () => PRODUCT_BY_SKU,
});
