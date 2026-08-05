import { auth } from "./config";

// Returns the signed-in user from the Auth.js session. Middleware enforces
// signed-in for non-public paths, so reaching here without a session is a
// server-side bug — we throw rather than redirect (redirects belong in
// middleware / server components). All downstream queries scope by `userId`;
// this is the single switch point.
export async function getCurrentUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    isAdmin: session.user.isAdmin,
    hasAnthropicKey: session.user.hasAnthropicKey,
    hasDeepseekKey: session.user.hasDeepseekKey,
    canUseServerKey: session.user.canUseServerKey,
  };
}
