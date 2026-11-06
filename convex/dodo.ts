"use node";
declare const process: { env: Record<string, string | undefined> };
// DodoPayments checkout + webhook verify (Node runtime). Secrets never leave Convex.
import DodoPayments from "dodopayments";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { PRODUCT_BY_SKU, SKU_RE, skuFromProductId } from "./iapProducts";

function dodoClient() {
  const bearerToken = process.env.DODO_PAYMENTS_API_KEY;
  if (!bearerToken) throw new Error("DODO_PAYMENTS_API_KEY not set");
  const environment = process.env.DODO_PAYMENTS_ENVIRONMENT === "test_mode" ? "test_mode" : "live_mode";
  return new DodoPayments({
    bearerToken,
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
    environment,
  });
}

/** Create a hosted checkout session for one skin SKU; client redirects to checkout_url. */
export const createSkinCheckout = action({
  args: {
    sku: v.string(),
    playerId: v.string(),
    origin: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (_ctx, { sku, playerId, origin, email }): Promise<{ checkout_url: string; session_id: string }> => {
    if (!SKU_RE.test(sku) || !PRODUCT_BY_SKU[sku]) throw new Error("unknown sku");
    if (playerId.length < 8 || playerId.length > 64) throw new Error("bad player_id");
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new Error("bad origin");
    }
    if (originUrl.protocol !== "https:" && originUrl.hostname !== "localhost") throw new Error("origin must be https");
    const base = originUrl.origin;
    const client = dodoClient();
    const session = await client.checkoutSessions.create({
      product_cart: [{ product_id: PRODUCT_BY_SKU[sku], quantity: 1 }],
      return_url: `${base}/?unlock=${encodeURIComponent(sku)}`,
      cancel_url: `${base}/`,
      metadata: { app: "scrappy-yard", sku, player_id: playerId },
      ...(email ? { customer: { email } } : {}),
    });
    if (!session.checkout_url) throw new Error("no checkout_url");
    return { checkout_url: session.checkout_url, session_id: session.session_id };
  },
});

type WebhookResult =
  | { ok: true; duplicate: true }
  | { ok: true; duplicate: false; sku: string }
  | { ok: false; reason: string }
  | { ok: true; granted: false; type: string };

/** Verify Dodo webhook signature and grant on payment.succeeded only. */
export const processWebhook = internalAction({
  args: {
    rawBody: v.string(),
    webhookId: v.string(),
    webhookSignature: v.string(),
    webhookTimestamp: v.string(),
  },
  handler: async (ctx, a): Promise<WebhookResult> => {
    if (!a.webhookId) throw new Error("missing webhook-id");
    const already = await ctx.runQuery(internal.iap.webhookSeen, { webhookId: a.webhookId });
    if (already) return { ok: true, duplicate: true };

    if (!process.env.DODO_PAYMENTS_WEBHOOK_KEY) throw new Error("DODO_PAYMENTS_WEBHOOK_KEY not set");
    const client = dodoClient();
    let type = "";
    let data: Record<string, unknown> = {};
    try {
      const event = client.webhooks.unwrap(a.rawBody, {
        headers: {
          "webhook-id": a.webhookId,
          "webhook-signature": a.webhookSignature,
          "webhook-timestamp": a.webhookTimestamp,
        },
      }) as unknown as { type?: string; data?: Record<string, unknown> };
      type = String(event.type ?? "");
      data = (event.data ?? {}) as Record<string, unknown>;
    } catch (e) {
      console.error("[dodo] unwrap failed", e);
      throw new Error("invalid signature");
    }

    const meta = (data.metadata ?? {}) as Record<string, string>;
    const paymentId = typeof data.payment_id === "string" ? data.payment_id : undefined;
    let sku = typeof meta.sku === "string" ? meta.sku : "";
    const playerId = typeof meta.player_id === "string" ? meta.player_id : "";
    if (!sku) {
      const cart = data.product_cart as { product_id?: string }[] | undefined;
      sku = skuFromProductId(cart?.[0]?.product_id) ?? "";
    }

    if (type === "payment.succeeded") {
      const r = await ctx.runMutation(internal.iap.grantUnlockInternal, {
        guestId: playerId,
        sku,
        webhookId: a.webhookId,
        paymentId,
      });
      if (r.ok && "duplicate" in r && r.duplicate) return { ok: true, duplicate: true };
      if (r.ok && "sku" in r && r.sku) return { ok: true, duplicate: false, sku: r.sku };
      return { ok: false, reason: ("reason" in r && r.reason) || "grant failed" };
    }

    // processing / failed / cancelled / other — ack + store, never grant
    await ctx.runMutation(internal.iap.recordWebhook, {
      webhookId: a.webhookId,
      type,
      sku: sku || undefined,
      playerId: playerId || undefined,
      paymentId,
      note: type === "payment.processing" ? "ignored processing" : "no grant",
    });
    return { ok: true, granted: false, type };
  },
});
