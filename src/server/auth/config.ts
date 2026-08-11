import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";

import { prisma } from "../db/prisma";
import { hasServerKeyAccess, oauthProviders } from "../platform/deployment";
import { notifyAdmin } from "../platform/notifications/pushAdmin";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      isAdmin: boolean;
      // Derived from the User key columns by the session callback so the client
      // can gate UI (chat input, banner) without an extra fetch. Server-side
      // enforcement still flows through resolveDeepseekApiKey (chat) /
      // resolveAnthropicApiKey (vision). hasDeepseekKey is the primary chat gate;
      // hasAnthropicKey only covers the vision carve-out.
      hasAnthropicKey: boolean;
      hasDeepseekKey: boolean;
      canUseServerKey: boolean;
    } & DefaultSession["user"];
  }
  interface User {
    isAdmin?: boolean;
    anthropicKeyEncrypted?: string | null;
    deepseekKeyEncrypted?: string | null;
    canUseServerKey?: boolean;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Only providers whose credentials are actually set — registering one without
  // them yields a button that always errors. allowDangerousEmailAccountLinking
  // lets a first-time OAuth sign-in attach to an existing User row by matching
  // email, which is how a seeded user and a second provider both land on one
  // account.
  providers: [
    ...(oauthProviders.google
      ? [Google({ allowDangerousEmailAccountLinking: true })]
      : []),
    ...(oauthProviders.github
      ? [GitHub({ allowDangerousEmailAccountLinking: true })]
      : []),
  ],
  pages: {
    signIn: "/signin",
    error: "/auth/error",
  },
  session: { strategy: "database" },
  // The Prisma adapter type chain hits a known mismatch with the PrismaPg
  // adapter-wrapped client (see @auth/prisma-adapter README); the runtime
  // behavior is correct.

  adapter: PrismaAdapter(prisma as any),
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      session.user.isAdmin = Boolean(user.isAdmin);
      session.user.hasAnthropicKey = Boolean(user.anthropicKeyEncrypted);
      session.user.hasDeepseekKey = Boolean(user.deepseekKeyEncrypted);
      // The EFFECTIVE answer, not the raw column — the key resolvers gate on
      // the same function, so a UI that read the column alone would show a
      // blocked state to a user the server will happily serve.
      session.user.canUseServerKey = hasServerKeyAccess(
        Boolean(user.canUseServerKey),
      );
      return session;
    },
  },
  events: {
    createUser({ user }) {
      // Fire-and-forget; signup must not block on push delivery.
      void notifyAdmin(
        "New Hank signup",
        `${user.name ?? user.email ?? "Someone"} just signed up`,
      );
    },
  },
});
