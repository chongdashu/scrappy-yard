// Scrappy Yard Convex Auth — Google, GitHub, X/Twitter.
// OAuth client IDs/secrets live in Convex env (AUTH_*); SITE_URL + JWT keys required.
// See docs/direction/auth-oauth-setup.md for the credential checklist.
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import Twitter from "@auth/core/providers/twitter";
import { convexAuth } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const cleanName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "Driver";

/** Ensure a leaderboard player row for a brand-new OAuth user. */
async function ensureAuthPlayer(
  ctx: MutationCtx,
  userId: Id<"users">,
  providerId: string,
  profile: Record<string, unknown>,
) {
  const guestId = `auth:${userId}`.slice(0, 64);
  const existing = await ctx.db
    .query("players")
    .withIndex("by_guest", (q) => q.eq("guestId", guestId))
    .unique();
  if (existing) return;

  let suggested = "Driver";
  let needsUsernameConfirm = false;
  if (providerId === "google") {
    suggested = cleanName(String(profile.name ?? "Driver"));
    needsUsernameConfirm = true; // modal: confirm/change display name before it's final
  } else if (providerId === "github") {
    suggested = cleanName(String(profile.login ?? profile.name ?? "Driver"));
  } else if (providerId === "twitter") {
    suggested = cleanName(String(profile.username ?? profile.name ?? "Driver"));
  } else {
    suggested = cleanName(String(profile.name ?? "Driver"));
  }

  await ctx.db.insert("players", {
    guestId,
    username: suggested,
    createdAt: Date.now(),
    bestDistance: 0,
    bestNuts: 0,
    bestAt: 0,
    runs: 0,
    authUserId: userId,
    provider: providerId,
    needsUsernameConfirm,
  });
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Google,
    GitHub({
      profile(profile) {
        return {
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email: profile.email,
          image: profile.avatar_url,
          // Extra field for afterUserCreatedOrUpdated (not stored on users).
          login: profile.login,
        };
      },
    }),
    Twitter({
      // Need the @handle; default user.fields omit username.
      userinfo: "https://api.x.com/2/users/me?user.fields=profile_image_url,username",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      profile(raw: any) {
        const data = raw?.data ?? raw;
        return {
          id: String(data.id),
          name: data.name ?? data.username ?? "Driver",
          email: data.email ?? null,
          image: data.profile_image_url,
          username: data.username,
        };
      },
    }),
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, args) {
      // First sign-in only — returning users keep their player username / confirm flag.
      if (args.existingUserId) return;
      if (args.type !== "oauth") return;
      const providerId = args.provider.id;
      await ensureAuthPlayer(ctx, args.userId, providerId, args.profile as Record<string, unknown>);
    },
  },
});
