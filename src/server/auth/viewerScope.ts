import { notFound } from "next/navigation";

import { prisma } from "@/server/db/prisma";

import { getCurrentUser } from "./currentUser";

type Caller = Awaited<ReturnType<typeof getCurrentUser>>;

type ViewerScope = {
  caller: Caller;
  viewedUserId: string;
  impersonating: { sessionId: string; targetUserId: string } | null;
};

// Resolve which user's data a read endpoint should return. By default this is
// the signed-in caller. Admins may pass `?impersonate=<chatSessionId>` to read
// that session's owner's data instead — gated through the same `notFound()`
// pattern as requireAdmin so non-admin probes can't distinguish "no permission"
// from "no such session".
export async function resolveViewedUser(req: Request): Promise<ViewerScope> {
  const caller = await getCurrentUser();
  const impersonateSessionId = new URL(req.url).searchParams.get("impersonate");
  if (!impersonateSessionId) {
    return { caller, viewedUserId: caller.id, impersonating: null };
  }
  if (!caller.isAdmin) {
    notFound();
  }
  const session = await prisma.chatSession.findUnique({
    where: { id: impersonateSessionId },
    select: { id: true, userId: true },
  });
  if (!session) {
    notFound();
  }
  return {
    caller,
    viewedUserId: session.userId,
    impersonating: { sessionId: session.id, targetUserId: session.userId },
  };
}

// Write-path guard: returns a 403 Response if the request carries an
// `?impersonate=` param (i.e. came from the admin view-session UI), and null
// otherwise. The UI already hides write affordances in admin-view-session
// mode; this is the belt-and-suspenders that ensures impersonation can never
// cause a write under any userId. Call at the top of every write/streaming
// route: `const blocked = rejectImpersonatedWrite(req); if (blocked) return blocked;`
export function rejectImpersonatedWrite(req: Request): Response | null {
  if (new URL(req.url).searchParams.has("impersonate")) {
    return Response.json(
      { error: "writes are not permitted in admin view-session mode" },
      { status: 403 },
    );
  }
  return null;
}
