import {
  endActiveSessions,
  getOrCreateActiveSession,
} from "@/server/agent/session";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";

export const dynamic = "force-dynamic";

// End the user's active session and start a fresh one.
// Memory notes and watchlist persist; only the chat history is reset.
export async function POST(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  await endActiveSessions(user.id);
  const next = await getOrCreateActiveSession(user.id);
  return Response.json({ sessionId: next.id });
}
