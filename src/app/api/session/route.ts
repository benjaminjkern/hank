import { notFound } from "next/navigation";

import { getOrCreateActiveSession } from "@/server/agent/session";
import { prisma } from "@/server/db/prisma";
import { resolveViewedUser } from "@/server/platform/admin/viewerScope";
import { getActiveRun } from "@/server/platform/agent/stopRegistry";
import { loadChatTranscriptPage } from "@/server/views/chatTranscript";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { viewedUserId, impersonating } = await resolveViewedUser(req);
  const session = impersonating
    ? await prisma.chatSession.findUnique({
        where: { id: impersonating.sessionId },
        select: { id: true },
      })
    : await getOrCreateActiveSession(viewedUserId);
  if (!session) notFound();

  const url = new URL(req.url);
  const { messages, hasMore, isPaging } = await loadChatTranscriptPage(
    session.id,
    {
      before: url.searchParams.get("before"),
      limit: url.searchParams.get("limit"),
    },
  );

  if (isPaging) {
    return Response.json({ messages, hasMore });
  }

  return Response.json({
    sessionId: session.id,
    // True when a runUserMessage is in flight for this session right now —
    // including a run the server is still DRAINING after the client's SSE
    // stream dropped (the chat route deliberately finishes work for a gone
    // client; see /api/chat). The client uses this to show a "Hank is still
    // working" notice and poll until the run completes, instead of silently
    // rendering the partial persisted turn as if Hank were done. In-memory
    // registry, same process as the ALREADY_STREAMING guard — consistent by
    // construction.
    runActive: getActiveRun(session.id) !== null,
    messages,
    hasMore,
  });
}
