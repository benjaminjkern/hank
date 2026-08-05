// Stop endpoint. A single Stop press POSTs here and we abort the run's
// controller server-side — force tear-down of the in-flight Anthropic stream +
// sub-agents + tool handlers. The runner catches the abort, degrades to the
// partial that already streamed, and persists it (stoppedByUser=true) so the
// user keeps what they saw and can just ask Hank to continue. Stop lives OFF the
// SSE fetch-abort deliberately: a client disconnect must not kill the run, only
// an explicit Stop.

import { getActiveRun } from "@/server/agent/runtime/stopRegistry";
import { getOrCreateActiveSession } from "@/server/agent/session";
import { getCurrentUser } from "@/server/auth/currentUser";
import { rejectImpersonatedWrite } from "@/server/auth/viewerScope";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = rejectImpersonatedWrite(req);
  if (blocked) return blocked;
  const user = await getCurrentUser();
  const session = await getOrCreateActiveSession(user.id);
  const run = getActiveRun(session.id);
  if (!run) {
    return Response.json({ stopped: false, reason: "no active run" });
  }
  if (run.userId !== user.id) {
    return new Response("forbidden", { status: 403 });
  }
  // Abort the run's controller (runUserMessage threads this into
  // messages.stream + sub-agents + tool handlers).
  run.controller.abort();
  return Response.json({ stopped: true });
}
