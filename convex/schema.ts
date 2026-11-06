// Scrappy Yard leaderboard + Convex Auth tables.
// Ranking: each identity's best run, by distance (m, desc) then nuts (desc), then earliest.
// Identities (players.guestId):
//   - anonymous web guest: UUID from localStorage
//   - signed-in web: `auth:<convexUserId>`
//   - Wavedash host: `wd:<wavedashUserId>` (parallel; no Convex OAuth on that host)
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  players: defineTable({
    guestId: v.string(),
    username: v.string(),
    createdAt: v.number(),
    // Denormalised best run, so the board is one indexed read.
    bestDistance: v.number(),
    bestNuts: v.number(),
    bestAt: v.number(),
    runs: v.number(),
    // Present when this player was created via Convex Auth (web Google/GitHub/X).
    authUserId: v.optional(v.id("users")),
    provider: v.optional(v.string()), // "google" | "github" | "twitter"
    // Google first login: true until the user confirms/changes the display-name modal.
    needsUsernameConfirm: v.optional(v.boolean()),
    // Persistent wallet: hex nuts banked from every run (earn = submitRun; spend = future shop).
    coins: v.optional(v.number()),
    // Entitlements (skin SKUs etc.). Survive re-login; granted by Dodo webhook / Wavedash paid.
    unlocks: v.optional(v.array(v.string())),
    // Auth rows: guestId merged on first link (once). Guest rows: auth guestId they were merged into.
    linkedGuestId: v.optional(v.string()),
    mergedInto: v.optional(v.string()),
  })
    .index("by_guest", ["guestId"])
    .index("by_best", ["bestDistance", "bestNuts"])
    .index("by_auth", ["authUserId"]),
  runs: defineTable({
    playerId: v.id("players"),
    username: v.string(),
    distance: v.number(),
    nuts: v.number(),
    won: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_player", ["playerId"])
    .index("by_distance", ["distance", "nuts"]),
  // DodoPayments webhook idempotency (webhook-id header).
  dodoWebhooks: defineTable({
    webhookId: v.string(),
    processedAt: v.number(),
    type: v.string(),
    sku: v.optional(v.string()),
    playerId: v.optional(v.string()),
    paymentId: v.optional(v.string()),
    note: v.optional(v.string()),
  }).index("by_webhook", ["webhookId"]),
});
