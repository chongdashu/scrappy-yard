import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

/** DodoPayments webhook — verify via SDK unwrap, grant only on payment.succeeded. */
http.route({
  path: "/dodo-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const webhookId = request.headers.get("webhook-id") ?? "";
    const webhookSignature = request.headers.get("webhook-signature") ?? "";
    const webhookTimestamp = request.headers.get("webhook-timestamp") ?? "";
    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      return new Response(JSON.stringify({ error: "missing webhook headers" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    try {
      const result = await ctx.runAction(internal.dodo.processWebhook, {
        rawBody,
        webhookId,
        webhookSignature,
        webhookTimestamp,
      });
      return new Response(JSON.stringify({ received: true, ...result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "webhook error";
      const status = /invalid signature/i.test(msg) ? 401 : 500;
      console.error("[dodo-webhook]", msg);
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  }),
});

export default http;
